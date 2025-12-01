require('dotenv').config();
const { WebSocketProvider, Interface } = require('ethers');
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');

// Supabase setup
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// Exchange rate API configuration
const EXCHANGE_API_URL = `https://v6.exchangerate-api.com/v6/${process.env.EXCHANGE_API_KEY}/latest/USD`;

const depositAmounts = new Map(); // Store deposit amounts temporarily
const intentDetails = new Map();
const orchestratorIntentDetails = new Map(); // intentHash -> {depositId, escrow, paymentMethod, owner, to, amount, fiatCurrency, conversionRate, timestamp}

// Database helper functions
class DatabaseManager {
  // Initialize user if not exists
  async initUser(chatId, username = null, firstName = null, lastName = null) {
    const { data, error } = await supabase
      .from('users')
      .upsert({ 
        chat_id: chatId,
        username: username,
        first_name: firstName,
        last_name: lastName,
        last_active: new Date().toISOString() 
      }, { 
        onConflict: 'chat_id',
        ignoreDuplicates: false 
      });
    
    if (error) console.error('Error initializing user:', error);
    return data;
  }

  // Get user's ACTIVE tracked deposits only
  async getUserDeposits(chatId) {
    const { data, error } = await supabase
      .from('user_deposits')
      .select('deposit_id, status')
      .eq('chat_id', chatId)
      .eq('is_active', true); // Only get active deposits
    
    if (error) {
      console.error('Error fetching user deposits:', error);
      return new Set();
    }
    
    return new Set(data.map(row => row.deposit_id));
  }

  // Get user's ACTIVE deposit states only
  async getUserDepositStates(chatId) {
    const { data, error } = await supabase
      .from('user_deposits')
      .select('deposit_id, status, intent_hash')
      .eq('chat_id', chatId)
      .eq('is_active', true); // Only get active deposits
    
    if (error) {
      console.error('Error fetching user deposit states:', error);
      return new Map();
    }
    
    const statesMap = new Map();
    data.forEach(row => {
      statesMap.set(row.deposit_id, {
        status: row.status,
        intentHash: row.intent_hash
      });
    });
    
    return statesMap;
  }

  // Add deposit for user (always creates as active)
  async addUserDeposit(chatId, depositId) {
    const { error } = await supabase
      .from('user_deposits')
      .upsert({ 
        chat_id: chatId, 
        deposit_id: depositId,
        status: 'tracking',
        is_active: true, // Explicitly set as active
        created_at: new Date().toISOString()
      }, { 
        onConflict: 'chat_id,deposit_id' 
      });
    
    if (error) console.error('Error adding deposit:', error);
  }

  // Remove deposit - mark as inactive instead of deleting
  async removeUserDeposit(chatId, depositId) {
    const { error } = await supabase
      .from('user_deposits')
      .update({ 
        is_active: false,
        updated_at: new Date().toISOString()
      })
      .eq('chat_id', chatId)
      .eq('deposit_id', depositId);
    
    if (error) console.error('Error removing deposit:', error);
  }

  // Update deposit status (only for active deposits)
  async updateDepositStatus(chatId, depositId, status, intentHash = null) {
    const updateData = { 
      status: status,
      updated_at: new Date().toISOString()
    };
    
    if (intentHash) {
      updateData.intent_hash = intentHash;
    }

    const { error } = await supabase
      .from('user_deposits')
      .update(updateData)
      .eq('chat_id', chatId)
      .eq('deposit_id', depositId)
      .eq('is_active', true); // Only update active deposits
    
    if (error) console.error('Error updating deposit status:', error);
  }

  // Get ACTIVE listen all preference only
  async getUserListenAll(chatId) {
    const { data, error } = await supabase
      .from('user_settings')
      .select('listen_all')
      .eq('chat_id', chatId)
      .eq('is_active', true) // Only get active settings
      .single();
    
    if (error && error.code !== 'PGRST116') { // PGRST116 = no rows returned
      console.error('Error getting listen all:', error);
    }
    return data?.listen_all || false;
  }

  async setUserListenAll(chatId, listenAll) {
    const { error } = await supabase
      .from('user_settings')
      .upsert({ 
        chat_id: chatId, 
        listen_all: listenAll,
        is_active: true, // Always active when setting
        updated_at: new Date().toISOString()
      }, { 
        onConflict: 'chat_id' 
      });
    
    if (error) console.error('Error setting listen all:', error);
  }

  // Clear user data - mark as inactive (PRESERVES DATA FOR ANALYTICS)
  async clearUserData(chatId) {
    const timestamp = new Date().toISOString();
    
    // Mark deposits as inactive instead of deleting
    const { error: error1 } = await supabase
      .from('user_deposits')
      .update({ 
        is_active: false,
        updated_at: timestamp
      })
      .eq('chat_id', chatId);
    
    // Mark settings as inactive instead of deleting  
    const { error: error2 } = await supabase
      .from('user_settings')
      .update({ 
        is_active: false,
        updated_at: timestamp
      })
      .eq('chat_id', chatId);

    // Clear sniper settings too
    const { error: error3 } = await supabase
      .from('user_snipers')
      .update({ 
        is_active: false,
        updated_at: timestamp
      })
      .eq('chat_id', chatId);
    
    if (error1) console.error('Error clearing user deposits:', error1);
    if (error2) console.error('Error clearing user settings:', error2);
    if (error3) console.error('Error clearing user snipers:', error3);
  }

  // Log event notification (for analytics)
  async logEventNotification(chatId, depositId, eventType) {
    const { error } = await supabase
      .from('event_notifications')
      .insert({
        chat_id: chatId,
        deposit_id: depositId,
        event_type: eventType,
        sent_at: new Date().toISOString()
      });
    
    if (error) console.error('Error logging notification:', error);
  }

  // Get users interested in a deposit (only ACTIVE users/settings)
  async getUsersInterestedInDeposit(depositId) {
    // Users listening to all deposits (ACTIVE settings only)
    const { data: allListeners } = await supabase
      .from('user_settings')
      .select('chat_id')
      .eq('listen_all', true)
      .eq('is_active', true); // Only active "listen all" users
    
    // Users tracking specific deposit (ACTIVE tracking only)
    const { data: specificTrackers } = await supabase
      .from('user_deposits')
      .select('chat_id')
      .eq('deposit_id', depositId)
      .eq('is_active', true); // Only active deposit tracking
    
    const allUsers = new Set();
    
    allListeners?.forEach(user => allUsers.add(user.chat_id));
    specificTrackers?.forEach(user => allUsers.add(user.chat_id));
    
    return Array.from(allUsers);
  }

  // BONUS: Analytics methods (new!)
  async getAnalytics() {
    // Total users who ever used the bot
    const { data: totalUsers } = await supabase
      .from('users')
      .select('chat_id', { count: 'exact' });

    // Currently active trackers
    const { data: activeTrackers } = await supabase
      .from('user_deposits')
      .select('chat_id', { count: 'exact' })
      .eq('is_active', true);

    // Total tracking sessions (including cleared ones)
    const { data: allTimeTracking } = await supabase
      .from('user_deposits')
      .select('chat_id', { count: 'exact' });

    // Most tracked deposits
    const { data: popularDeposits } = await supabase
      .from('user_deposits')
      .select('deposit_id')
      .eq('is_active', true);

    return {
      totalUsers: totalUsers?.length || 0,
      activeTrackers: activeTrackers?.length || 0,
      allTimeTracking: allTimeTracking?.length || 0,
      popularDeposits: popularDeposits || []
    };
  }
  
async removeUserSniper(chatId, currency = null, platform = null) {
  let query = supabase
    .from('user_snipers')
    .update({ 
      is_active: false,
      updated_at: new Date().toISOString()
    })
    .eq('chat_id', chatId);
  
  if (currency) {
    query = query.eq('currency', currency.toUpperCase());
  }
  
  if (platform) {
    query = query.eq('platform', platform.toLowerCase());
  }
  
  const { error } = await query;
  if (error) console.error('Error removing sniper:', error);
}

async setUserSniper(chatId, currency, platform = null) {
  // Always insert - no deactivation needed
  const { error } = await supabase
    .from('user_snipers')
    .insert({
      chat_id: chatId,
      currency: currency.toUpperCase(),
      platform: platform ? platform.toLowerCase() : null,
      is_active: true,
      created_at: new Date().toISOString()
    });
  
  if (error) {
    console.error('Error setting sniper:', error);
    return false;
  }
  return true;
}

async getUserSnipers(chatId) {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  
  const { data, error } = await supabase
    .from('user_snipers')
    .select('currency, platform, created_at')
    .eq('chat_id', chatId)
    .eq('is_active', true) 
    .gte('created_at', thirtyDaysAgo.toISOString())
    .order('created_at', { ascending: false });
  
  if (error) {
    console.error('Error fetching user snipers:', error);
    return [];
  }
  
  // Deduplicate - keep only the newest entry for each currency+platform combo
  const unique = new Map();
  data.forEach(row => {
    const key = `${row.currency}-${row.platform ?? 'all'}`; // ← Add fallback for null
    const existing = unique.get(key);
    if (!existing || new Date(row.created_at) > new Date(existing.created_at)) {
      unique.set(key, row);
    }
  });

  return Array.from(unique.values());
}

  async getUsersWithSniper(currency, platform = null) {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  
  let query = supabase
    .from('user_snipers')
    .select('chat_id, currency, platform, created_at')
    .eq('currency', currency.toUpperCase())
    .eq('is_active', true)
    .gte('created_at', thirtyDaysAgo.toISOString());
  
  // If platform is specified, match exactly OR get users with null platform (all platforms)
  if (platform) {
    // Get users who either specified this platform OR want all platforms (null)
    query = query.or(`platform.eq.${platform.toLowerCase()},platform.is.null`);
  }
  
  const { data, error } = await query;
  
  if (error) {
    console.error('Error fetching users with sniper:', error);
    return [];
  }
  
  // Deduplicate by chat_id - if user has multiple entries, keep the newest
  const userMap = new Map();
  data.forEach(row => {
    const existing = userMap.get(row.chat_id);
    if (!existing || new Date(row.created_at) > new Date(existing.created_at)) {
      userMap.set(row.chat_id, row);
    }
  });
  
  return Array.from(userMap.keys()); // Return just the chat IDs
}

  async logSniperAlert(chatId, depositId, currency, depositRate, marketRate, percentageDiff) {
    const { error } = await supabase
      .from('sniper_alerts')
      .insert({
        chat_id: chatId,
        deposit_id: depositId,
        currency: currency,
        deposit_rate: depositRate,
        market_rate: marketRate,
        percentage_diff: percentageDiff,
        sent_at: new Date().toISOString()
      });
    
    if (error) console.error('Error logging sniper alert:', error);
  }

  async storeDepositAmount(depositId, amount) {
  // Store in memory for quick access
    depositAmounts.set(Number(depositId), Number(amount));
  
  // Also store in database for persistence
  const { error } = await supabase
    .from('deposit_amounts')
    .upsert({ 
      deposit_id: Number(depositId),
      amount: Number(amount),
      created_at: new Date().toISOString()
    }, { 
      onConflict: 'deposit_id' 
    });
  
    if (error) console.error('Error storing deposit amount:', error);
  }

  async getDepositAmount(depositId) {
  // Try memory first
    const memoryAmount = depositAmounts.get(Number(depositId));
    if (memoryAmount) return memoryAmount;
  
  // Fall back to database
    const { data, error } = await supabase
      .from('deposit_amounts')
      .select('amount')
      .eq('deposit_id', Number(depositId))
      .single();
  
    if (error) {
      console.error('Error getting deposit amount:', error);
      return 0;
    }
  
    return data?.amount || 0;
  }
// Get user's global sniper threshold
async getUserThreshold(chatId) {
  const { data, error } = await supabase
    .from('user_settings')
    .select('threshold')
    .eq('chat_id', chatId)
    .eq('is_active', true)
    .single();
  
  if (error && error.code !== 'PGRST116') {
    console.error('Error getting user threshold:', error);
  }
  return data?.threshold || 0.2; // Default to 0.2% if not set
}

// Set user's global sniper threshold
async setUserThreshold(chatId, threshold) {
  const { error } = await supabase
    .from('user_settings')
    .upsert({ 
      chat_id: chatId, 
      threshold: threshold,
      is_active: true,
      updated_at: new Date().toISOString()
    }, { 
      onConflict: 'chat_id' 
    });
  
  if (error) console.error('Error setting user threshold:', error);
}
  
}

async function postToDiscord({
  webhookUrl,
  content,
  components = null,
  threadId = null,
  username = 'ZKP2P Alerts',
  avatar_url = undefined
}) {
  if (!webhookUrl) return; // silently skip if not configured

  const url = threadId ? `${webhookUrl}?thread_id=${threadId}` : webhookUrl;

  const body = { content, username, avatar_url };
  if (components) body.components = components;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  // Simple rate-limit handling
  if (res.status === 429) {
    const j = await res.json().catch(() => ({}));
    const retryMs = Math.ceil((j.retry_after || 1) * 1000);
    await new Promise(r => setTimeout(r, retryMs));
    return postToDiscord({ webhookUrl, content, components, threadId, username, avatar_url });
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    console.error('Discord webhook error:', res.status, txt);
  }
}

function linkButton(label, url) {
  return [
    {
      type: 1, // ActionRow
      components: [
        { type: 2, style: 5, label, url } // ButtonStyle.Link
      ]
    }
  ];
}

function toDiscordMarkdown(msg) {
  // Turn *bold* (Telegram) into **bold** (Discord)
  // Non-greedy so it won't over-capture
  return msg.replace(/\*(.*?)\*/g, '**$1**');
}



const db = new DatabaseManager();

const ZKP2P_GROUP_ID = -1001928949520;
const ZKP2P_TOPIC_ID = 5385;
const ZKP2P_SNIPER_TOPIC_ID = 5671;

const initializeBot = async () => {
  try {
    console.log('🔄 Bot initialization starting...');
    
    // Test Telegram bot connection first
    try {
      const botInfo = await bot.getMe();
      console.log(`🤖 Bot connected: @${botInfo.username} (${botInfo.first_name})`);
    } catch (error) {
      console.error('❌ Failed to connect to Telegram bot:', error.message);
      throw error;
    }
    
    // Test database connection
    try {
      const { data, error } = await supabase.from('users').select('chat_id').limit(1);
      if (error) throw error;
      console.log('✅ Database connection successful');
    } catch (error) {
      console.error('❌ Database connection failed:', error.message);
      throw error;
    }
    
    // Wait for all systems to be ready
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    console.log('📝 Initializing user in database...');
    await db.initUser(ZKP2P_GROUP_ID, 'zkp2p_channel');
    
    console.log('📝 Setting listen all to true...');
    await db.setUserListenAll(ZKP2P_GROUP_ID, true);
    await db.setUserThreshold(ZKP2P_GROUP_ID, 0.1);

    console.log(`📤 Attempting to send message to topic ${ZKP2P_TOPIC_ID} in group ${ZKP2P_GROUP_ID}`);
    
    // Test message sending with better error handling
    const result = await bot.sendMessage(ZKP2P_GROUP_ID, '🔄 Bot restarted and ready!', {
      parse_mode: 'Markdown',
      message_thread_id: ZKP2P_TOPIC_ID,
    });

    console.log('✅ Initialization message sent successfully!');
    console.log('📋 Message details:', {
      message_id: result.message_id,
      chat_id: result.chat.id,
      thread_id: result.message_thread_id,
      is_topic_message: result.is_topic_message
    });
    
  } catch (err) {
    console.error('❌ Bot initialization failed:', err);
    console.error('❌ Error code:', err.code);
    console.error('❌ Error message:', err.message);
    
    if (err.response?.body) {
      console.error('❌ Telegram API response:', JSON.stringify(err.response.body, null, 2));
    }
    
    // Schedule retry
    console.log('🔄 Retrying initialization in 30 seconds...');
    setTimeout(initializeBot, 30000);
  }
};

// Start initialization after a delay
setTimeout(initializeBot, 3000);



// Exchange rate fetcher
let exchangeRatesCache = null;
let lastRatesFetch = 0;
const RATES_CACHE_DURATION = 60000; // 1 minute cache

// ARS rate cache (CriptoYa API)
let arsRateCache = null;
let lastARSFetch = 0;
const ARS_CACHE_DURATION = 60000; // 1 minute cache

async function getExchangeRates() {
  const now = Date.now();
  
  // Return cached rates if still fresh
  if (exchangeRatesCache && (now - lastRatesFetch) < RATES_CACHE_DURATION) {
    return exchangeRatesCache;
  }
  
  try {
    const response = await fetch(EXCHANGE_API_URL);
    const data = await response.json();
    
    if (data.result === 'success') {
      exchangeRatesCache = data.conversion_rates;
      lastRatesFetch = now;
      console.log('📊 Exchange rates updated');
      return exchangeRatesCache;
    } else {
      console.error('❌ Exchange API error:', data);
      return null;
    }
  } catch (error) {
    console.error('❌ Failed to fetch exchange rates:', error);
    return null;
  }
}

// Fetch ARS rate from CriptoYa API
async function getARSRate() {
  const now = Date.now();
  
  // Return cached rate if still fresh
  if (arsRateCache && (now - lastARSFetch) < ARS_CACHE_DURATION) {
    return arsRateCache;
  }
  
  try {
    const response = await fetch('https://criptoya.com/api/dolar');
    const data = await response.json();
    
    if (data && data.cripto && data.cripto.usdc && data.cripto.usdc.ask && data.cripto.usdc.bid) {
      // Use USDC mid price (average of ask and bid)
      const midPrice = (data.cripto.usdc.ask + data.cripto.usdc.bid) / 2;
      arsRateCache = midPrice;
      lastARSFetch = now;
      console.log(`📊 ARS rate updated from CriptoYa: ${arsRateCache} ARS/USDC (mid: ask=${data.cripto.usdc.ask}, bid=${data.cripto.usdc.bid})`);
      return arsRateCache;
    } else {
      console.error('❌ CriptoYa API error: missing cripto.usdc rate', data);
      return null;
    }
  } catch (error) {
    console.error('❌ Failed to fetch ARS rate from CriptoYa:', error);
    return null;
  }
}


// Enhanced WebSocket Provider with better connection stability
class ResilientWebSocketProvider {
  constructor(url, contractAddress, eventHandler) {
    this.url = url;
    this.contractAddress = contractAddress;
    this.eventHandler = eventHandler;
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 30000;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 50;
    this.isConnecting = false;
    this.isDestroyed = false;
    this.provider = null;
    this.reconnectTimer = null;
    this.keepAliveTimer = null; // Add keep-alive timer
    this.lastActivityTime = Date.now();
    
    this.connect();
  }

  async connect() {
    if (this.isConnecting || this.isDestroyed) return;
    this.isConnecting = true;

    try {
      console.log(`🔌 Attempting WebSocket connection (attempt ${this.reconnectAttempts + 1})`);
      
      // Properly cleanup existing provider
      if (this.provider) {
        await this.cleanup();
      }

      // Add connection options for better stability
      this.provider = new WebSocketProvider(this.url, undefined, {
        // Add connection options
        reconnectInterval: 5000,
        maxReconnectInterval: 30000,
        reconnectDecay: 1.5,
        timeoutInterval: 10000,
        maxReconnectAttempts: null, // We handle this ourselves
        debug: false
      });

      this.setupEventListeners();
      
      // Test connection with timeout
      const networkPromise = this.provider.getNetwork();
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Connection timeout')), 15000) // Increased timeout
      );
      
      await Promise.race([networkPromise, timeoutPromise]);
      
      console.log('✅ WebSocket connected successfully');
      this.lastActivityTime = Date.now();
      
      this.reconnectAttempts = 0;
      this.reconnectDelay = 1000;
      this.isConnecting = false;
      
      this.setupContractListening();
      this.startKeepAlive(); // Start keep-alive mechanism
      
    } catch (error) {
      console.error('❌ WebSocket connection failed:', error.message);
      this.isConnecting = false;
      
      // Only schedule reconnect if not destroyed
      if (!this.isDestroyed) {
        this.scheduleReconnect();
      }
    }
  }

  async cleanup() {
    if (this.provider) {
      try {
        // Stop keep-alive first
        this.stopKeepAlive();
        
        // Remove all listeners first
        this.provider.removeAllListeners();
        
        // Close WebSocket connection if it exists
        if (this.provider._websocket) {
          this.provider._websocket.removeAllListeners();
          if (this.provider._websocket.readyState === 1) { // OPEN
            this.provider._websocket.close(1000, 'Normal closure'); // Proper close code
          }
        }
        
        // Destroy provider
        if (typeof this.provider.destroy === 'function') {
          await this.provider.destroy();
        }
        
        console.log('🧹 Cleaned up existing provider');
      } catch (error) {
        console.error('⚠️ Error during cleanup:', error.message);
      }
    }
  }

  setupEventListeners() {
    if (!this.provider || this.isDestroyed) return;
    
    if (this.provider._websocket) {
      this.provider._websocket.on('close', (code, reason) => {
        console.log(`🔌 WebSocket closed: ${code} - ${reason}`);
        this.stopKeepAlive();
        if (!this.isDestroyed) {
          // Add delay before reconnecting to avoid rapid reconnections
          setTimeout(() => {
            if (!this.isDestroyed) {
              this.scheduleReconnect();
            }
          }, 2000);
        }
      });
  
      this.provider._websocket.on('error', (error) => {
        console.error('❌ WebSocket error:', error.message);
        this.stopKeepAlive();
        if (!this.isDestroyed) {
          this.scheduleReconnect();
        }
      });

      // Enhanced ping/pong handling
      this.provider._websocket.on('ping', (data) => {
        console.log('🏓 WebSocket ping received');
        this.lastActivityTime = Date.now();
        this.provider._websocket.pong(data); // Respond to ping
      });

      this.provider._websocket.on('pong', () => {
        console.log('🏓 WebSocket pong received');
        this.lastActivityTime = Date.now();
      });

      // Track any message activity
      this.provider._websocket.on('message', () => {
        this.lastActivityTime = Date.now();
      });
    }

    // Listen for provider events too
    this.provider.on('error', (error) => {
      console.error('❌ Provider error:', error.message);
      if (!this.isDestroyed) {
        this.scheduleReconnect();
      }
    });
  }

  startKeepAlive() {
    this.stopKeepAlive(); // Clear any existing timer
    
    // Send ping every 30 seconds to keep connection alive
    this.keepAliveTimer = setInterval(() => {
      if (this.provider && this.provider._websocket && this.provider._websocket.readyState === 1) {
        try {
          this.provider._websocket.ping();
          console.log('🏓 Sent keep-alive ping');
          
          // Check if we haven't received any activity in 90 seconds
          const timeSinceActivity = Date.now() - this.lastActivityTime;
          if (timeSinceActivity > 90000) {
            console.log('⚠️ No activity for 90 seconds, forcing reconnection');
            this.scheduleReconnect();
          }
        } catch (error) {
          console.error('❌ Keep-alive ping failed:', error.message);
          this.scheduleReconnect();
        }
      }
    }, 30000); // 30 seconds
  }

  stopKeepAlive() {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  setupContractListening() {
    if (!this.provider || this.isDestroyed) return;
    
    try {
      // Add error handling for the event listener
      this.provider.on({ address: this.contractAddress.toLowerCase() }, (log) => {
        this.lastActivityTime = Date.now(); // Update activity time on events
        this.eventHandler(log);
      });
      
      console.log(`👂 Listening for events on contract: ${this.contractAddress}`);
    } catch (error) {
      console.error('❌ Failed to set up contract listening:', error.message);
      if (!this.isDestroyed) {
        this.scheduleReconnect();
      }
    }
  }

  scheduleReconnect() {
    if (this.isConnecting || this.isDestroyed) return;
    
    // Clear existing timer if any
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    
    this.stopKeepAlive(); // Stop keep-alive during reconnection
    
    this.reconnectAttempts++;
    
    if (this.reconnectAttempts > this.maxReconnectAttempts) {
      console.error(`💀 Max reconnection attempts (${this.maxReconnectAttempts}) reached. Stopping.`);
      return;
    }

    const delay = Math.min(
      this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts), 
      this.maxReconnectDelay
    );
    
    console.log(`⏰ Scheduling reconnection in ${delay}ms (attempt ${this.reconnectAttempts})`);
    
    this.reconnectTimer = setTimeout(() => {
      if (!this.isDestroyed) {
        this.connect();
      }
    }, delay);
  }

  // Add manual restart method
  async restart() {
    console.log('🔄 Manual restart initiated...');
    this.reconnectAttempts = 0;
    this.reconnectDelay = 1000;
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    this.stopKeepAlive();
    await this.cleanup();
    
    // Wait a bit before reconnecting
    setTimeout(() => {
      if (!this.isDestroyed) {
        this.connect();
      }
    }, 3000); // Increased delay
  }

  // Add proper destroy method
  async destroy() {
    console.log('🛑 Destroying WebSocket provider...');
    this.isDestroyed = true;
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    this.stopKeepAlive();
    await this.cleanup();
    this.provider = null;
  }

  get currentProvider() {
    return this.provider;
  }

  get isConnected() {
    return this.provider && 
           this.provider._websocket && 
           this.provider._websocket.readyState === 1 && // WebSocket.OPEN
           (Date.now() - this.lastActivityTime) < 120000; // Active within 2 minutes
  }
}


// ZKP2P Escrow contract on Base (legacy)
const escrowContractAddress = '0xca38607d85e8f6294dc10728669605e6664c2d70';

// ZKP2P Orchestrator contract on Base (v2)
const orchestratorContractAddress = '0x88888883Ed048FF0a415271B28b2F52d431810D0';

// ABI with exact event definitions from the contract (including sniper events)
const abi = [
  `event IntentSignaled(
    bytes32 indexed intentHash,
    uint256 indexed depositId,
    address indexed verifier,
    address owner,
    address to,
    uint256 amount,
    bytes32 fiatCurrency,
    uint256 conversionRate,
    uint256 timestamp
  )`,
  `event IntentFulfilled(
    bytes32 indexed intentHash,
    uint256 indexed depositId,
    address indexed verifier,
    address owner,
    address to,
    uint256 amount,
    uint256 sustainabilityFee,
    uint256 verifierFee
  )`,
  `event IntentPruned(
    bytes32 indexed intentHash,
    uint256 indexed depositId
  )`,
  `event DepositReceived(
    uint256 indexed depositId,
    address indexed depositor,  
    address indexed token,
    uint256 amount,
    tuple(uint256,uint256) intentAmountRange
  )`,
  `event DepositCurrencyAdded(
    uint256 indexed depositId,
    address indexed verifier,
    bytes32 indexed currency,
    uint256 conversionRate
  )`,
  `event DepositVerifierAdded(
    uint256 indexed depositId,
    address indexed verifier,
    bytes32 indexed payeeDetailsHash,
    address intentGatingService
  )`,
  `event DepositWithdrawn(
    uint256 indexed depositId,
    address indexed depositor,
    uint256 amount
  )`,
  `event DepositClosed(
    uint256 depositId,
    address depositor
  )`,
  `event DepositCurrencyRateUpdated(
    uint256 indexed depositId,
    address indexed verifier,
    bytes32 indexed currency,
    uint256 conversionRate
  )`,
  `event BeforeExecution()`,
  `event UserOperationEvent(
    bytes32 indexed userOpHash,
    address indexed sender,
    address indexed paymaster,
    uint256 nonce,
    bool success,
    uint256 actualGasCost,
    uint256 actualGasUsed
)`,
`event DepositConversionRateUpdated(
  uint256 indexed depositId,
  address indexed verifier,
  bytes32 indexed currency,
  uint256 newConversionRate
)`
];

// Orchestrator ABI (v2) - different event structure
const orchestratorAbi = [
  `event IntentSignaled(
    bytes32 indexed intentHash,
    address indexed escrow,
    uint256 indexed depositId,
    bytes32 paymentMethod,
    address owner,
    address to,
    uint256 amount,
    bytes32 fiatCurrency,
    uint256 conversionRate,
    uint256 timestamp
  )`,
  `event IntentFulfilled(
    bytes32 indexed intentHash,
    address indexed fundsTransferredTo,
    uint256 amount,
    bool isManualRelease
  )`,
  `event IntentPruned(
    bytes32 indexed intentHash
)`
];

const iface = new Interface(abi);
const orchestratorIface = new Interface(orchestratorAbi);
const pendingTransactions = new Map(); // txHash -> {fulfilled: Set, pruned: Set, blockNumber: number, rawIntents: Map}
const processingScheduled = new Set(); // Track which transactions are scheduled for processing

function scheduleTransactionProcessing(txHash) {
  if (processingScheduled.has(txHash)) return; // Already scheduled
  
  processingScheduled.add(txHash);
  
  setTimeout(async () => {
    await processCompletedTransaction(txHash);
    processingScheduled.delete(txHash);
  }, 10000); // Wait 10 seconds for all events to arrive
}

async function processCompletedTransaction(txHash) {
  const txData = pendingTransactions.get(txHash);
  if (!txData) return;
  
  console.log(`🔄 Processing completed transaction ${txHash}`);
  
  // Process pruned intents first, but skip if also fulfilled
  for (const intentHash of txData.pruned) {
    if (txData.fulfilled.has(intentHash)) {
      console.log(`Intent ${intentHash} was both pruned and fulfilled in tx ${txHash}, prioritizing fulfilled status`);
      continue; // Skip sending pruned notification
    }
    
    // Send pruned notification
    const rawIntent = txData.rawIntents.get(intentHash);
    if (rawIntent) {
      if (rawIntent.eventType === 'orchestrator') {
        await sendOrchestratorPrunedNotification(rawIntent, txHash);
      } else {
        await sendPrunedNotification(rawIntent, txHash);
      }
    }
  }
  
  // Process fulfilled intents
  for (const intentHash of txData.fulfilled) {
    const rawIntent = txData.rawIntents.get(intentHash);
    if (rawIntent) {
      if (rawIntent.eventType === 'orchestrator') {
        await sendOrchestratorFulfilledNotification(rawIntent, txHash);
      } else {
        await sendFulfilledNotification(rawIntent, txHash);
      }
    }
  }
  
  // Clean up
  pendingTransactions.delete(txHash);
}

async function sendFulfilledNotification(rawIntent, txHash) {
  const { depositId, verifier, owner, to, amount, sustainabilityFee, verifierFee, intentHash } = rawIntent;
  const platformName = getPlatformName(verifier);

  const storedDetails = intentDetails.get(intentHash.toLowerCase());
  let rateText = '';
  if (storedDetails) {
    const fiatCode = getFiatCode(storedDetails.fiatCurrency);
    const formattedRate = formatConversionRate(storedDetails.conversionRate, fiatCode);
    rateText = `\n- *Rate:* ${formattedRate}`;
  
  // Clean up memory after use
  intentDetails.delete(intentHash.toLowerCase());
  }
  
  const interestedUsers = await db.getUsersInterestedInDeposit(depositId);
  if (interestedUsers.length === 0) return;
  
  console.log(`📤 Sending fulfillment to ${interestedUsers.length} users interested in deposit ${depositId}`);
  
  const message = `
🟢 *Order Fulfilled*
- *Deposit ID:* \`${depositId}\`
- *Order ID:* \`${intentHash}\`
- *Platform:* ${platformName}
- *Owner:* \`${owner}\`
- *To:* \`${to}\`
- *Amount:* ${formatUSDC(amount)} USDC${rateText}
- *Sustainability Fee:* ${formatUSDC(sustainabilityFee)} USDC
- *Verifier Fee:* ${formatUSDC(verifierFee)} USDC
- *Tx:* [View on BaseScan](${txLink(txHash)})
`.trim();

  await postToDiscord({
    webhookUrl: process.env.DISCORD_ORDERS_WEBHOOK_URL,
    threadId: process.env.DISCORD_ORDERS_THREAD_ID || null,
    content: toDiscordMarkdown(message),
    components: linkButton(`🔗 View Deposit ${depositId}`, txLink(txHash) || depositLink(depositId))
  });


  for (const chatId of interestedUsers) {
    await db.updateDepositStatus(chatId, depositId, 'fulfilled', intentHash);
    await db.logEventNotification(chatId, depositId, 'fulfilled');
    
    const sendOptions = { 
      parse_mode: 'Markdown', 
      disable_web_page_preview: true,
      reply_markup: createDepositKeyboard(depositId)
    };
    if (chatId === ZKP2P_GROUP_ID) {
      sendOptions.message_thread_id = ZKP2P_TOPIC_ID;
    }
    bot.sendMessage(chatId, message, sendOptions);
  }
}

async function sendPrunedNotification(rawIntent, txHash) {
  const { depositId, intentHash } = rawIntent;
  
  const interestedUsers = await db.getUsersInterestedInDeposit(depositId);
  if (interestedUsers.length === 0) return;
  
  console.log(`📤 Sending cancellation to ${interestedUsers.length} users interested in deposit ${depositId}`);
  
  const message = `
🟠 *Order Cancelled*
- *Deposit ID:* \`${depositId}\`
- *Order ID:* \`${intentHash}\`
- *Tx:* [View on BaseScan](${txLink(txHash)})

*Order was cancelled*
`.trim();

  await postToDiscord({
    webhookUrl: process.env.DISCORD_ORDERS_WEBHOOK_URL,
    threadId: process.env.DISCORD_ORDERS_THREAD_ID || null,
    content: toDiscordMarkdown(message),
    components: linkButton(`🔗 View Deposit ${depositId}`, txLink(txHash) || depositLink(depositId))
  });


  for (const chatId of interestedUsers) {
    await db.updateDepositStatus(chatId, depositId, 'pruned', intentHash);
    await db.logEventNotification(chatId, depositId, 'pruned');
    
    const sendOptions = { 
      parse_mode: 'Markdown', 
      disable_web_page_preview: true,
      reply_markup: createDepositKeyboard(depositId)
    };
    if (chatId === ZKP2P_GROUP_ID) {
      sendOptions.message_thread_id = ZKP2P_TOPIC_ID;
    }
    bot.sendMessage(chatId, message, sendOptions);
  }
}

async function sendOrchestratorFulfilledNotification(rawIntent, txHash) {
  const { intentHash, fundsTransferredTo, amount, isManualRelease } = rawIntent;
  const intentHashLower = intentHash.toLowerCase();
  
  // Get stored intent details
  const storedDetails = orchestratorIntentDetails.get(intentHashLower);
  if (!storedDetails) {
    console.log('⚠️ No stored details for intent:', intentHash);
    return;
  }
  
  // Also try intentDetails for backward compatibility
  const oldIntentDetails = intentDetails.get(intentHashLower);
  const verifier = storedDetails.escrow || oldIntentDetails?.verifier || 'Unknown';
  
  const depositId = storedDetails.depositId;
  const { owner, fiatCurrency, conversionRate, paymentMethod } = storedDetails;
  
  // Try to get platform name from payment method first (Orchestrator v2/v3), fallback to verifier address
  const platformName = paymentMethod ? getPlatformName(paymentMethod) : getPlatformName(verifier);
  
  let rateText = '';
  if (oldIntentDetails || storedDetails.fiatCurrency) {
    const fiatCode = getFiatCode(storedDetails.fiatCurrency);
    const formattedRate = formatConversionRate(storedDetails.conversionRate || 0n, fiatCode);
    rateText = `\n- *Rate:* ${formattedRate}`;
  }
  
  const interestedUsers = await db.getUsersInterestedInDeposit(depositId);
  if (interestedUsers.length === 0) return;
  
  console.log(`📤 Sending fulfillment to ${interestedUsers.length} users interested in deposit ${depositId}`);
  
  const message = `
🟢 *Order Fulfilled*
- *Deposit ID:* \`${depositId}\`
- *Order ID:* \`${intentHash}\`
- *Platform:* ${platformName}
- *Owner:* \`${owner}\`
- *To:* \`${fundsTransferredTo}\`
- *Amount:* ${formatUSDC(amount)} USDC${rateText}
- *Manual Release:* ${isManualRelease ? 'Yes' : 'No'}
- *Tx:* [View on BaseScan](${txLink(txHash)})
`.trim();

  await postToDiscord({
    webhookUrl: process.env.DISCORD_ORDERS_WEBHOOK_URL,
    threadId: process.env.DISCORD_ORDERS_THREAD_ID || null,
    content: toDiscordMarkdown(message),
    components: linkButton(`🔗 View Deposit ${depositId}`, txLink(txHash) || depositLink(depositId))
  });

  for (const chatId of interestedUsers) {
    await db.updateDepositStatus(chatId, depositId, 'fulfilled', intentHash);
    await db.logEventNotification(chatId, depositId, 'fulfilled');
    
    const sendOptions = { 
      parse_mode: 'Markdown', 
      disable_web_page_preview: true,
      reply_markup: createDepositKeyboard(depositId)
    };
    if (chatId === ZKP2P_GROUP_ID) {
      sendOptions.message_thread_id = ZKP2P_TOPIC_ID;
    }
    bot.sendMessage(chatId, message, sendOptions);
  }
  
  // Clean up
  orchestratorIntentDetails.delete(intentHashLower);
  intentDetails.delete(intentHashLower);
}

async function sendOrchestratorPrunedNotification(rawIntent, txHash) {
  const { intentHash } = rawIntent;
  const intentHashLower = intentHash.toLowerCase();
  
  // Get stored intent details
  const storedDetails = orchestratorIntentDetails.get(intentHashLower);
  if (!storedDetails) {
    console.log('⚠️ No stored details for intent:', intentHash);
    return;
  }
  
  const depositId = storedDetails.depositId;
  
  const interestedUsers = await db.getUsersInterestedInDeposit(depositId);
  if (interestedUsers.length === 0) return;
  
  console.log(`📤 Sending cancellation to ${interestedUsers.length} users interested in deposit ${depositId}`);
  
  const message = `
🟠 *Order Cancelled*
- *Deposit ID:* \`${depositId}\`
- *Order ID:* \`${intentHash}\`
- *Tx:* [View on BaseScan](${txLink(txHash)})

*Order was cancelled*
`.trim();

  await postToDiscord({
    webhookUrl: process.env.DISCORD_ORDERS_WEBHOOK_URL,
    threadId: process.env.DISCORD_ORDERS_THREAD_ID || null,
    content: toDiscordMarkdown(message),
    components: linkButton(`🔗 View Deposit ${depositId}`, txLink(txHash) || depositLink(depositId))
  });

  for (const chatId of interestedUsers) {
    await db.updateDepositStatus(chatId, depositId, 'pruned', intentHash);
    await db.logEventNotification(chatId, depositId, 'pruned');
    
    const sendOptions = { 
      parse_mode: 'Markdown', 
      disable_web_page_preview: true,
      reply_markup: createDepositKeyboard(depositId)
    };
    if (chatId === ZKP2P_GROUP_ID) {
      sendOptions.message_thread_id = ZKP2P_TOPIC_ID;
    }
    bot.sendMessage(chatId, message, sendOptions);
  }
  
  // Clean up
  orchestratorIntentDetails.delete(intentHashLower);
  intentDetails.delete(intentHashLower);
}



// Unified platform mapping (supports both verifier addresses and payment method hashes)
// Works for Escrow v1 (addresses) and Orchestrator v2/v3 (payment method hashes)
const platformMapping = {
  // Verifier addresses (Escrow v1) - 40 chars
  '0x76d33a33068d86016b806df02376ddbb23dd3703': { platform: 'cashapp', isUsdOnly: true },
  '0x9a733b55a875d0db4915c6b36350b24f8ab99df5': { platform: 'venmo', isUsdOnly: true },
  '0xaa5a1b62b01781e789c900d616300717cd9a41ab': { platform: 'revolut', isUsdOnly: false },
  '0xff0149799631d7a5bde2e7ea9b306c42b3d9a9ca': { platform: 'wise', isUsdOnly: false },
  '0x03d17e9371c858072e171276979f6b44571c5dea': { platform: 'paypal', isUsdOnly: false },
  '0x0de46433bd251027f73ed8f28e01ef05da36a2e0': { platform: 'monzo', isUsdOnly: false },
  '0xf2ac5be14f32cbe6a613cff8931d95460d6c33a3': { platform: 'mercado pago', isUsdOnly: false },
  '0x431a078a5029146aab239c768a615cd484519af7': { platform: 'zelle', isUsdOnly: true },
  // Payment method hashes (Orchestrator v2/v3) - 66 chars
  '0x90262a3db0edd0be2369c6b28f9e8511ec0bac7136cefbada0880602f87e7268': { platform: 'venmo', isUsdOnly: true },
  '0x617f88ab82b5c1b014c539f7e75121427f0bb50a4c58b187a238531e7d58605d': { platform: 'revolut', isUsdOnly: false },
  '0x10940ee67cfb3c6c064569ec92c0ee934cd7afa18dd2ca2d6a2254fcb009c17d': { platform: 'cashapp', isUsdOnly: true },
  '0x554a007c2217df766b977723b276671aee5ebb4adaea0edb6433c88b3e61dac5': { platform: 'wise', isUsdOnly: false },
  '0xa5418819c024239299ea32e09defae8ec412c03e58f5c75f1b2fe84c857f5483': { platform: 'mercado pago', isUsdOnly: false },
  '0x817260692b75e93c7fbc51c71637d4075a975e221e1ebc1abeddfabd731fd90d': { platform: 'zelle', isUsdOnly: true },
  '0x6aa1d1401e79ad0549dced8b1b96fb72c41cd02b32a7d9ea1fed54ba9e17152e': { platform: 'zelle', isUsdOnly: true },
  '0x4bc42b322a3ad413b91b2fde30549ca70d6ee900eded1681de91aaf32ffd7ab5': { platform: 'zelle', isUsdOnly: true },
  '0x3ccc3d4d5e769b1f82dc4988485551dc0cd3c7a3926d7d8a4dde91507199490f': { platform: 'paypal', isUsdOnly: false },
  '0x62c7ed738ad3e7618111348af32691b5767777fbaf46a2d8943237625552645c': { platform: 'monzo', isUsdOnly: false }
};

// Unified platform name lookup - works with both verifier addresses and payment method hashes
const getPlatformName = (identifier) => {
  const mapping = platformMapping[identifier.toLowerCase()];
  if (mapping) {
    // Normalize zelle variants to just "zelle" for display
    return mapping.platform.startsWith('zelle') ? 'zelle' : mapping.platform;
  }
  // Show truncated identifier for unknown platforms
  const identifierStr = identifier.toLowerCase();
  if (identifierStr.length === 42) {
    // Address format (40 chars + 0x)
    return `Unknown (${identifierStr.slice(0, 6)}...${identifierStr.slice(-4)})`;
  } else {
    // Hash format (64 chars + 0x)
    return `Unknown (${identifierStr.slice(0, 8)}...${identifierStr.slice(-6)})`;
  }
};

// Helper functions
const formatUSDC = (amount) => (Number(amount) / 1e6).toFixed(2);
const formatTimestamp = (ts) => new Date(Number(ts) * 1000).toUTCString();
const txLink = (hash) => `https://basescan.org/tx/${hash}`;
const depositLink = (id) => `https://www.zkp2p.xyz/deposit/${id}`;

const currencyHashToCode = {
  '0x4dab77a640748de8588de6834d814a344372b205265984b969f3e97060955bfa': 'AED',
  '0x8fd50654b7dd2dc839f7cab32800ba0c6f7f66e1ccf89b21c09405469c2175ec': 'ARS',
  '0xcb83cbb58eaa5007af6cad99939e4581c1e1b50d65609c30f303983301524ef3': 'AUD',
  '0x221012e06ebf59a20b82e3003cf5d6ee973d9008bdb6e2f604faa89a27235522': 'CAD',
  '0xc9d84274fd58aa177cabff54611546051b74ad658b939babaad6282500300d36': 'CHF',
  '0xfaaa9c7b2f09d6a1b0971574d43ca62c3e40723167c09830ec33f06cec921381': 'CNY',
  '0xd783b199124f01e5d0dde2b7fc01b925e699caea84eae3ca92ed17377f498e97': 'CZK',
  '0x5ce3aa5f4510edaea40373cbe83c091980b5c92179243fe926cb280ff07d403e': 'DKK',
  '0xfff16d60be267153303bbfa66e593fb8d06e24ea5ef24b6acca5224c2ca6b907': 'EUR',
  '0x90832e2dc3221e4d56977c1aa8f6a6706b9ad6542fbbdaac13097d0fa5e42e67': 'GBP',
  '0xa156dad863111eeb529c4b3a2a30ad40e6dcff3b27d8f282f82996e58eee7e7d': 'HKD',
  '0x7766ee347dd7c4a6d5a55342d89e8848774567bcf7a5f59c3e82025dbde3babb': 'HUF',
  '0xc681c4652bae8bd4b59bec1cdb90f868d93cc9896af9862b196843f54bf254b3': 'IDR',
  '0x313eda7ae1b79890307d32a78ed869290aeb24cc0e8605157d7e7f5a69fea425': 'ILS',
  '0xaad766fbc07fb357bed9fd8b03b935f2f71fe29fc48f08274bc2a01d7f642afc': 'INR',
  '0xfe13aafd831cb225dfce3f6431b34b5b17426b6bff4fccabe4bbe0fe4adc0452': 'JPY',
  '0x589be49821419c9c2fbb26087748bf3420a5c13b45349828f5cac24c58bbaa7b': 'KES',
  '0xa94b0702860cb929d0ee0c60504dd565775a058bf1d2a2df074c1db0a66ad582': 'MXN',
  '0xf20379023279e1d79243d2c491be8632c07cfb116be9d8194013fb4739461b84': 'MYR',
  '0x8fb505ed75d9d38475c70bac2c3ea62d45335173a71b2e4936bd9f05bf0ddfea': 'NOK',
  '0xdbd9d34f382e9f6ae078447a655e0816927c7c3edec70bd107de1d34cb15172e': 'NZD',
  '0xe6c11ead4ee5ff5174861adb55f3e8fb2841cca69bf2612a222d3e8317b6ae06': 'PHP',
  '0x9a788fb083188ba1dfb938605bc4ce3579d2e085989490aca8f73b23214b7c1d': 'PLN',
  '0x2dd272ddce846149d92496b4c3e677504aec8d5e6aab5908b25c9fe0a797e25f': 'RON',
  '0xf998cbeba8b7a7e91d4c469e5fb370cdfa16bd50aea760435dc346008d78ed1f': 'SAR',
  '0x8895743a31faedaa74150e89d06d281990a1909688b82906f0eb858b37f82190': 'SEK',
  '0xc241cc1f9752d2d53d1ab67189223a3f330e48b75f73ebf86f50b2c78fe8df88': 'SGD',
  '0x326a6608c2a353275bd8d64db53a9d772c1d9a5bc8bfd19dfc8242274d1e9dd4': 'THB',
  '0x128d6c262d1afe2351c6e93ceea68e00992708cfcbc0688408b9a23c0c543db2': 'TRY',
  '0xc4ae21aac0c6549d71dd96035b7e0bdb6c79ebdba8891b666115bc976d16a29e': 'USD',
  '0xe85548baf0a6732cfcc7fc016ce4fd35ce0a1877057cfec6e166af4f106a3728': 'VND',
  '0x53611f0b3535a2cfc4b8deb57fa961ca36c7b2c272dfe4cb239a29c48e549361': 'ZAR'
};

const getFiatCode = (hash) => currencyHashToCode[hash.toLowerCase()] || '❓ Unknown';

const formatConversionRate = (conversionRate, fiatCode) => {
  const rate = (Number(conversionRate) / 1e18).toFixed(6);
  return `${rate} ${fiatCode} / USDC`;
};

const createDepositKeyboard = (depositId) => {
  return {
    inline_keyboard: [[
      {
        text: `🔗 View Deposit ${depositId}`,
        url: depositLink(depositId)
      }
    ]]
  };
};

// Sniper logic
async function checkSniperOpportunity(depositId, depositAmount, currencyHash, conversionRate, verifierAddress) {
  const currencyCode = currencyHashToCode[currencyHash.toLowerCase()];
  const platformName = getPlatformName(verifierAddress).toLowerCase();

  if (!currencyCode) return; // Only skip unknown currencies
  
  console.log(`🎯 Checking sniper opportunity for deposit ${depositId}, currency: ${currencyCode}`);
  
  // Get market rate - use CriptoYa API for ARS, otherwise use standard exchange API
  let marketRate;
  if (currencyCode === 'ARS') {
    marketRate = await getARSRate();
    if (!marketRate) {
      console.log('❌ No ARS rate available from CriptoYa');
      return;
    }
  } else if (currencyCode === 'USD') {
    // For USD, market rate is always 1.0 - better to hardcode than to call the api (i guess)
    marketRate = 1.0;
  } else {
    // Get current exchange rates for other currencies
    const exchangeRates = await getExchangeRates();
    if (!exchangeRates) {
      console.log('❌ No exchange rates available for sniper check');
      return;
    }
    marketRate = exchangeRates[currencyCode];
    if (!marketRate) {
      console.log(`❌ No market rate found for ${currencyCode}`);
      return;
    }
  }
  
  // Calculate rates
  const depositRate = Number(conversionRate) / 1e18; // Convert from wei
  const percentageDiff = ((marketRate - depositRate) / marketRate) * 100;
  
  console.log(`📊 Market rate: ${marketRate} ${currencyCode}/USD`);
  console.log(`📊 Deposit rate: ${depositRate} ${currencyCode}/USD`);
  console.log(`📊 Percentage difference: ${percentageDiff.toFixed(2)}%`);
  
// Get users with their custom thresholds and check each one individually
const interestedUsers = await db.getUsersWithSniper(currencyCode, platformName);

if (!interestedUsers.includes(ZKP2P_GROUP_ID)) {
  interestedUsers.push(ZKP2P_GROUP_ID);
}

if (interestedUsers.length > 0) {
  console.log(`🎯 Checking thresholds for ${interestedUsers.length} potential users`);
  
  for (const chatId of interestedUsers) {
    const userThreshold = await db.getUserThreshold(chatId);
    
    if (percentageDiff >= userThreshold) {
      console.log(`🎯 SNIPER OPPORTUNITY for user ${chatId}! ${percentageDiff.toFixed(2)}% >= ${userThreshold}%`);
      
      const formattedAmount = (Number(depositAmount) / 1e6).toFixed(2);
      const message = `
🎯 *SNIPER ALERT - ${currencyCode}*
🏦 *Platform:* ${platformName}
📊 New Deposit #${depositId}: ${formattedAmount} USDC
💰 Deposit Rate: ${depositRate.toFixed(4)} ${currencyCode}/USD
📈 Market Rate: ${marketRate.toFixed(4)} ${currencyCode}/USD  
🔥 ${percentageDiff.toFixed(1)}% BETTER than market!

💵 *If you filled this entire order:*
- You'd pay: ${(Number(depositAmount) / 1e6 * depositRate).toFixed(2)} ${currencyCode}
- Market cost: ${(Number(depositAmount) / 1e6 * marketRate).toFixed(2)} ${currencyCode}
- **You save: ${((Number(depositAmount) / 1e6) * (marketRate - depositRate)).toFixed(2)} ${currencyCode}**

*You get ${currencyCode} at ${percentageDiff.toFixed(1)}% discount on ${platformName}!*
`.trim();

      await db.logSniperAlert(chatId, depositId, currencyCode, depositRate, marketRate, percentageDiff);
      
const sendOptions = { 
  parse_mode: 'Markdown',
  reply_markup: {
    inline_keyboard: [[
      {
        text: `🔗 Snipe Deposit ${depositId}`,
        url: depositLink(depositId)
      }
    ]]
  }
};

// Send sniper messages to the sniper topic
if (chatId === ZKP2P_GROUP_ID) {
  sendOptions.message_thread_id = ZKP2P_SNIPER_TOPIC_ID;
}

// Mirror to Discord sniper webhook (once per alert path)
await postToDiscord({
  webhookUrl: process.env.DISCORD_SNIPER_WEBHOOK_URL,
  threadId: process.env.DISCORD_SNIPER_THREAD_ID || null,
  content: toDiscordMarkdown(message),
  components: linkButton(`🔗 Snipe Deposit ${depositId}`, depositLink(depositId))
});


bot.sendMessage(chatId, message, sendOptions);
    } else {
      console.log(`📊 No opportunity for user ${chatId}: ${percentageDiff.toFixed(2)}% < ${userThreshold}%`);
    }
  }
} else {
  console.log(`📊 No users interested in sniping ${currencyCode} on ${platformName}`);
}
}
  

// Telegram commands - now using database
bot.onText(/\/deposit (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const input = match[1].trim().toLowerCase();
  
  // Initialize user
  await db.initUser(chatId, msg.from.username, msg.from.first_name, msg.from.last_name);
  
  if (input === 'all') {
    await db.setUserListenAll(chatId, true);
    bot.sendMessage(chatId, `🌍 *Now listening to ALL deposits!*\n\nYou will receive notifications for every event on every deposit.\n\nUse \`/deposit stop\` to stop listening to all deposits.`, { parse_mode: 'Markdown' });
    return;
  }
  
  if (input === 'stop') {
    await db.setUserListenAll(chatId, false);
    bot.sendMessage(chatId, `🛑 *Stopped listening to all deposits.*\n\nYou will now only receive notifications for specifically tracked deposits.`, { parse_mode: 'Markdown' });
    return;
  }
  
  const newIds = input.split(/[,\s]+/).map(id => parseInt(id.trim())).filter(id => !isNaN(id));
  
  if (newIds.length === 0) {
    bot.sendMessage(chatId, `❌ No valid deposit IDs provided. Use:\n• \`/deposit all\` - Listen to all deposits\n• \`/deposit 123\` - Track specific deposit\n• \`/deposit 123,456,789\` - Track multiple deposits`, { parse_mode: 'Markdown' });
    return;
  }
  
  for (const id of newIds) {
    await db.addUserDeposit(chatId, id);
  }
  
  const userDeposits = await db.getUserDeposits(chatId);
  const idsArray = Array.from(userDeposits).sort((a, b) => a - b);
  bot.sendMessage(chatId, `✅ Now tracking deposit IDs: \`${idsArray.join(', ')}\``, { parse_mode: 'Markdown' });
});

bot.onText(/\/remove (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const idsString = match[1];
  const idsToRemove = idsString.split(/[,\s]+/).map(id => parseInt(id.trim())).filter(id => !isNaN(id));
  
  if (idsToRemove.length === 0) {
    bot.sendMessage(chatId, `❌ No valid deposit IDs provided. Use: /remove 123 or /remove 123,456,789`, { parse_mode: 'Markdown' });
    return;
  }
  
  for (const id of idsToRemove) {
    await db.removeUserDeposit(chatId, id);
  }
  
  const userDeposits = await db.getUserDeposits(chatId);
  const remainingIds = Array.from(userDeposits).sort((a, b) => a - b);
  
  if (remainingIds.length > 0) {
    bot.sendMessage(chatId, `✅ Removed specified IDs. Still tracking: \`${remainingIds.join(', ')}\``, { parse_mode: 'Markdown' });
  } else {
    bot.sendMessage(chatId, `✅ Removed specified IDs. No deposits being tracked.`, { parse_mode: 'Markdown' });
  }
});

bot.onText(/\/list/, async (msg) => {
  const chatId = msg.chat.id;
  const userDeposits = await db.getUserDeposits(chatId);
  const userStates = await db.getUserDepositStates(chatId);
  const listeningAll = await db.getUserListenAll(chatId);
  const snipers = await db.getUserSnipers(chatId);
  
  let message = '';
  
  if (listeningAll) {
    message += `🌍 *Listening to ALL deposits*\n\n`;
  }
  
  if (snipers.length > 0) {
    message += `🎯 *Active Snipers:*\n`;
    snipers.forEach(sniper => {
      const platformText = sniper.platform ? ` on ${sniper.platform}` : ' (all platforms)';
      message += `• ${sniper.currency}${platformText}\n`;
    });
    message += `\n`;
  }
  
  const idsArray = Array.from(userDeposits).sort((a, b) => a - b);
  if (idsArray.length === 0 && !listeningAll && snipers.length === 0) {
    bot.sendMessage(chatId, `📋 No deposits currently being tracked and no snipers set.`, { parse_mode: 'Markdown' });
    return;
  }
  
  if (idsArray.length > 0) {
    message += `📋 *Specifically tracking ${idsArray.length} deposits:*\n\n`;
    idsArray.forEach(id => {
      const state = userStates.get(id);
      const status = state ? state.status : 'tracking';
      const emoji = status === 'fulfilled' ? '✅' : 
                    status === 'pruned' ? '🟠' : '👀';
      message += `${emoji} \`${id}\` - ${status}\n`;
    });
  }
  
  bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

bot.onText(/\/clearall/, async (msg) => {
  const chatId = msg.chat.id;
  await db.clearUserData(chatId);
  bot.sendMessage(chatId, `🗑️ Cleared all tracked deposit IDs, stopped listening to all deposits, and cleared all sniper settings.`, { parse_mode: 'Markdown' });
});

bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  
  try {
    const escrowConnected = resilientProvider?.isConnected || false;
    const orchestratorConnected = orchestratorProvider?.isConnected || false;
    const escrowStatus = escrowConnected ? '🟢 Connected' : '🔴 Disconnected';
    const orchestratorStatus = orchestratorConnected ? '🟢 Connected' : '🔴 Disconnected';
    
    // Test database connection
    let dbStatus = '🔴 Disconnected';
    try {
      const { data, error } = await supabase.from('users').select('chat_id').limit(1);
      if (!error) dbStatus = '🟢 Connected';
    } catch (error) {
      console.error('Database test failed:', error);
    }
    
    // Test Telegram connection
    let botStatus = '🔴 Disconnected';
    try {
      await bot.getMe();
      botStatus = '🟢 Connected';
    } catch (error) {
      console.error('Bot test failed:', error);
    }
    
    const listeningAll = await db.getUserListenAll(chatId);
    const trackedCount = (await db.getUserDeposits(chatId)).size;
    const snipers = await db.getUserSnipers(chatId);
    
    let message = `🔧 *System Status:*\n\n`;
    message += `• *Escrow WebSocket (v1):* ${escrowStatus}\n`;
    message += `• *Orchestrator WebSocket (v2):* ${orchestratorStatus}\n`;
    message += `• *Database:* ${dbStatus}\n`;
    message += `• *Telegram:* ${botStatus}\n\n`;
    message += `📊 *Your Settings:*\n`;
    
    if (listeningAll) {
      message += `• *Listening to:* ALL deposits\n`;
    } else {
      message += `• *Tracking:* ${trackedCount} specific deposits\n`;
    }
    
    if (snipers.length > 0) {
      message += `• *Sniping:* `;
      const sniperTexts = snipers.map(sniper => {
        const platformText = sniper.platform ? ` on ${sniper.platform}` : '';
        return `${sniper.currency}${platformText}`;
      });
      message += `${sniperTexts.join(', ')}\n`;
    }
    
    // Add reconnection info if disconnected
    if ((!escrowConnected && resilientProvider) || (!orchestratorConnected && orchestratorProvider)) {
      message += `\n⚠️ *Reconnection Attempts:*`;
      if (!escrowConnected && resilientProvider) {
        message += `\n• Escrow (v1): ${resilientProvider.reconnectAttempts}/${resilientProvider.maxReconnectAttempts}`;
      }
      if (!orchestratorConnected && orchestratorProvider) {
        message += `\n• Orchestrator (v2): ${orchestratorProvider.reconnectAttempts}/${orchestratorProvider.maxReconnectAttempts}`;
      }
    }
    
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    
  } catch (error) {
    console.error('Status command failed:', error);
    bot.sendMessage(chatId, '❌ Failed to get status', { parse_mode: 'Markdown' });
  }
});

// Sniper commands

bot.onText(/\/sniper threshold (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const input = match[1].trim();
  
  await db.initUser(chatId, msg.from.username, msg.from.first_name, msg.from.last_name);
  
  const threshold = parseFloat(input);
  
  if (isNaN(threshold)) {
    bot.sendMessage(chatId, `❌ Invalid threshold. Please provide a number (e.g., 0.5 for 0.5%)`, { parse_mode: 'Markdown' });
    return;
  }
  
  await db.setUserThreshold(chatId, threshold);
  
  bot.sendMessage(chatId, `🎯 *Sniper threshold set to ${threshold}%*\n\nYou'll now be alerted when deposits offer rates ${threshold}% or better than market rates.`, { parse_mode: 'Markdown' });
});


bot.onText(/\/sniper (?!threshold)(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const input = match[1].trim().toLowerCase();
  
  await db.initUser(chatId, msg.from.username, msg.from.first_name, msg.from.last_name);
  
  if (input === 'list') {
    const snipers = await db.getUserSnipers(chatId);
    if (snipers.length === 0) {
      bot.sendMessage(chatId, `🎯 No sniper currencies set.`, { parse_mode: 'Markdown' });
    } else {
      let message = `🎯 *Active Snipers:*\n\n`;
      snipers.forEach(sniper => {
        const platformText = sniper.platform ? ` on ${sniper.platform}` : ' (all platforms)';
        message += `• ${sniper.currency}${platformText}\n`;
      });
      bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }
    return;
  }
    
  
  if (input === 'clear') {
    await db.removeUserSniper(chatId);
    bot.sendMessage(chatId, `🎯 Cleared all sniper settings.`, { parse_mode: 'Markdown' });
    return;
  }
  
  // Parse input: "eur" or "eur revolut"
  const parts = input.split(' ');
  const currency = parts[0].toUpperCase();
  const platform = parts[1] ? parts[1].toLowerCase() : null;
  
  const supportedCurrencies = Object.values(currencyHashToCode);
  const supportedPlatforms = ['revolut', 'wise', 'cashapp', 'venmo', 'zelle'];
  
  if (!supportedCurrencies.includes(currency)) {
    bot.sendMessage(chatId, `❌ Currency '${currency}' not supported.\n\n*Supported currencies:*\n${supportedCurrencies.join(', ')}`, { parse_mode: 'Markdown' });
    return;
  }
  
  if (platform && !supportedPlatforms.includes(platform)) {
    bot.sendMessage(chatId, `❌ Platform '${platform}' not supported.\n\n*Supported platforms:*\n${supportedPlatforms.join(', ')}`, { parse_mode: 'Markdown' });
    return;
  }
  
  await db.setUserSniper(chatId, currency, platform);
  
  const platformText = platform ? ` on ${platform}` : ' (all platforms)';
  bot.sendMessage(chatId, `🎯 *Sniper activated for ${currency}${platformText}!*\n\nYou'll be alerted when new deposits offer better rates than market.`, { parse_mode: 'Markdown' });
});

bot.onText(/\/unsnipe (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const input = match[1].trim().toLowerCase();
  
  // Parse input: "eur" or "eur revolut"
  const parts = input.split(' ');
  const currency = parts[0].toUpperCase();
  const platform = parts[1] ? parts[1].toLowerCase() : null;
  
  await db.removeUserSniper(chatId, currency, platform);
  
  const platformText = platform ? ` on ${platform}` : ' (all platforms)';
  bot.sendMessage(chatId, `🎯 Stopped sniping ${currency}${platformText}.`, { parse_mode: 'Markdown' });
});

// Handle /start command - show help
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const helpMessage = `
🤖 *ZKP2P Tracker Commands:*

**Deposit Tracking:**
- \`/deposit all\` - Listen to ALL deposits (every event)
- \`/deposit stop\` - Stop listening to all deposits
- \`/deposit 123\` - Track a specific deposit
- \`/deposit 123,456,789\` - Track multiple deposits
- \`/remove 123\` - Stop tracking specific deposit(s)

**Sniper (Arbitrage Alerts):**
- \`/sniper eur\` - Snipe EUR on ALL platforms
- \`/sniper eur revolut\` - Snipe EUR only on Revolut
- \`/sniper usd zelle\` - Snipe USD only on Zelle
- \`/sniper threshold 0.5\` - Set your alert threshold to 0.5%
- \`/sniper list\` - Show active sniper settings
- \`/sniper clear\` - Clear all sniper settings
- \`/unsnipe eur\` - Stop sniping EUR (all platforms)
- \`/unsnipe eur wise\` - Stop sniping EUR on Wise only

**General:**
- \`/list\` - Show all tracking status (deposits + snipers)
- \`/clearall\` - Stop all tracking and clear everything
- \`/status\` - Check WebSocket connection and settings
- \`/help\` - Show this help message

*Note: Each user has their own settings. Sniper alerts you when deposits offer better exchange rates than market!*
`.trim();
  
  bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
});


bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  const helpMessage = `
🤖 *ZKP2P Tracker Commands:*

**Deposit Tracking:**
• \`/deposit all\` - Listen to ALL deposits (every event)
• \`/deposit stop\` - Stop listening to all deposits
• \`/deposit 123\` - Track a specific deposit
• \`/deposit 123,456,789\` - Track multiple deposits
• \`/remove 123\` - Stop tracking specific deposit(s)

**Sniper (Arbitrage Alerts):**
- \`/sniper eur\` - Snipe EUR on ALL platforms
- \`/sniper eur revolut\` - Snipe EUR only on Revolut
- \`/sniper usd zelle\` - Snipe USD only on Zelle
- \`/sniper threshold 0.5\` - Set your alert threshold to 0.5%
- \`/sniper list\` - Show active sniper settings
- \`/sniper clear\` - Clear all sniper settings
- \`/unsnipe eur\` - Stop sniping EUR (all platforms)
- \`/unsnipe eur wise\` - Stop sniping EUR on Wise only

**General:**
• \`/list\` - Show all tracking status (deposits + snipers)
• \`/clearall\` - Stop all tracking and clear everything
• \`/status\` - Check WebSocket connection and settings
• \`/help\` - Show this help message

*Note: Each user has their own settings. Sniper alerts you when deposits offer better exchange rates than market!*
`.trim();
  
  bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
});

// Event handler function - now with sniper support
const handleContractEvent = async (log) => {
  console.log('\n📦 Raw log received:');
  console.log(log);

  try {
    const parsed = iface.parseLog({ 
      data: log.data, 
      topics: log.topics 
    });
    
    if (!parsed) {
      console.log('⚠️ Log format did not match our ABI');
      console.log('📝 Event signature:', log.topics[0]);
      
      if (log.topics.length >= 3) {
        const topicDepositId = parseInt(log.topics[2], 16);
        console.log('📊 Extracted deposit ID from topic:', topicDepositId);
        
        const interestedUsers = await db.getUsersInterestedInDeposit(topicDepositId);
        if (interestedUsers.length > 0) {
          console.log(`⚠️ Sending unrecognized event to ${interestedUsers.length} users`);
          
          const message = `
⚠️ *Unrecognized Event for Deposit*
• *Deposit ID:* \`${topicDepositId}\`
• *Event Signature:* \`${log.topics[0]}\`
• *Block:* ${log.blockNumber}
• *Tx:* [View on BaseScan](${txLink(log.transactionHash)})
`.trim();
          
          interestedUsers.forEach(chatId => {
            const sendOptions = { 
              parse_mode: 'Markdown', 
              disable_web_page_preview: true,
              reply_markup: createDepositKeyboard(topicDepositId)
            };
            if (chatId === ZKP2P_GROUP_ID) {
              sendOptions.message_thread_id = ZKP2P_TOPIC_ID;
            }
            bot.sendMessage(chatId, message, sendOptions);
          });
        }
      }
      return;
    }
    
    console.log('✅ Parsed log:', parsed.name);
    console.log('🔍 Args:', parsed.args);

    const { name } = parsed;

    if (name === 'IntentSignaled') {
      const { intentHash, depositId, verifier, owner, to, amount, fiatCurrency, conversionRate, timestamp } = parsed.args;    
      const id = Number(depositId);
      const fiatCode = getFiatCode(fiatCurrency);
      const fiatAmount = ((Number(amount) / 1e6) * (Number(conversionRate) / 1e18)).toFixed(2);
      const platformName = getPlatformName(verifier);
      const formattedRate = formatConversionRate(conversionRate, fiatCode);
      
      console.log('🧪 IntentSignaled depositId:', id);
      
      intentDetails.set(intentHash.toLowerCase(), { fiatCurrency, conversionRate, verifier });
      
      const interestedUsers = await db.getUsersInterestedInDeposit(id);
      if (interestedUsers.length === 0) {
        console.log('🚫 Ignored — no users interested in this depositId.');
        return;
      }

      console.log(`📤 Sending to ${interestedUsers.length} users interested in deposit ${id}`);

      const message = `
🟡 *Order Created*
• *Deposit ID:* \`${id}\`
• *Order ID:* \`${intentHash}\`
• *Platform:* ${platformName}
• *Owner:* \`${owner}\`
• *To:* \`${to}\`
• *Amount:* ${formatUSDC(amount)} USDC
• *Fiat Amount:* ${fiatAmount} ${fiatCode} 
• *Rate:* ${formattedRate}
• *Time:* ${formatTimestamp(timestamp)}
• *Block:* ${log.blockNumber}
• *Tx:* [View on BaseScan](${txLink(log.transactionHash)})
`.trim();

      await postToDiscord({
        webhookUrl: process.env.DISCORD_ORDERS_WEBHOOK_URL,
        threadId: process.env.DISCORD_ORDERS_THREAD_ID || null,
        content: toDiscordMarkdown(message),
        components: linkButton(`🔗 View Deposit ${id}`, depositLink(id))
      });


      for (const chatId of interestedUsers) {
        await db.updateDepositStatus(chatId, id, 'signaled', intentHash);
        await db.logEventNotification(chatId, id, 'signaled');
        
        const sendOptions = { 
          parse_mode: 'Markdown', 
          disable_web_page_preview: true,
          reply_markup: createDepositKeyboard(id)
        };
        if (chatId === ZKP2P_GROUP_ID) {
          sendOptions.message_thread_id = ZKP2P_TOPIC_ID;
        }
        bot.sendMessage(chatId, message, sendOptions);
      }
    }

if (name === 'IntentFulfilled') {
  const { intentHash, depositId, verifier, owner, to, amount, sustainabilityFee, verifierFee } = parsed.args;
  const txHash = log.transactionHash;
  const id = Number(depositId);
  
  console.log('🧪 IntentFulfilled collected for batching - depositId:', id);
  
  // Initialize transaction data if not exists
  if (!pendingTransactions.has(txHash)) {
    pendingTransactions.set(txHash, {
      fulfilled: new Set(),
      pruned: new Set(),
      blockNumber: log.blockNumber,
      rawIntents: new Map()
    });
  }
  
  // Store the fulfillment data
  const txData = pendingTransactions.get(txHash);
  txData.fulfilled.add(intentHash.toLowerCase());
  txData.rawIntents.set(intentHash.toLowerCase(), {
    type: 'fulfilled',
    depositId: id,
    verifier,
    owner,
    to,
    amount,
    sustainabilityFee,
    verifierFee,
    intentHash
  });
  
  // Schedule processing this transaction
  scheduleTransactionProcessing(txHash);
}

if (name === 'IntentPruned') {
  const { intentHash, depositId } = parsed.args;
  const txHash = log.transactionHash;
  const id = Number(depositId);
  
  console.log('🧪 IntentPruned collected for batching - depositId:', id);
  
  // Initialize transaction data if not exists
  if (!pendingTransactions.has(txHash)) {
    pendingTransactions.set(txHash, {
      fulfilled: new Set(),
      pruned: new Set(),
      blockNumber: log.blockNumber,
      rawIntents: new Map()
    });
  }
  
  // Store the pruned data
  const txData = pendingTransactions.get(txHash);
  txData.pruned.add(intentHash.toLowerCase());
  txData.rawIntents.set(intentHash.toLowerCase(), {
    type: 'pruned',
    depositId: id,
    intentHash
  });
  
  // Schedule processing this transaction
  scheduleTransactionProcessing(txHash);
}

if (name === 'DepositWithdrawn') {
  const { depositId, depositor, amount } = parsed.args;
  const id = Number(depositId);
  
  console.log(`💸 DepositWithdrawn: ${formatUSDC(amount)} USDC from deposit ${id} by ${depositor} - ignored`);
  return;
}

if (name === 'DepositClosed') {
  const { depositId, depositor } = parsed.args;
  const id = Number(depositId);
  
  console.log(`🔒 DepositClosed: deposit ${id} by ${depositor} - ignored`);
  return;
}

if (name === 'BeforeExecution') {
  console.log(`🛠️ BeforeExecution event detected at block ${log.blockNumber}`);
  return;
}

if (name === 'UserOperationEvent') {
  const { userOpHash, sender, paymaster, nonce, success, actualGasCost, actualGasUsed } = parsed.args;
  console.log(`📡 UserOperationEvent:
  • Hash: ${userOpHash}
  • Sender: ${sender}
  • Paymaster: ${paymaster}
  • Nonce: ${nonce}
  • Success: ${success}
  • Gas Used: ${actualGasUsed}
  • Gas Cost: ${actualGasCost}
  • Block: ${log.blockNumber}`);
  return;
}

    
if (name === 'DepositCurrencyRateUpdated') {
  const { depositId, verifier, currency, conversionRate } = parsed.args;
  const id = Number(depositId);
  const fiatCode = getFiatCode(currency);
  const rate = (Number(conversionRate) / 1e18).toFixed(6);
  const platform = getPlatformName(verifier);

  console.log(`📶 DepositCurrencyRateUpdated - ID: ${id}, ${platform}, ${fiatCode} rate updated to ${rate}`);
  
  // Check for sniper opportunity with updated rate
  const depositAmount = await db.getDepositAmount(id);
  if (depositAmount > 0) {
    console.log(`🎯 Rechecking sniper opportunity due to rate update for deposit ${id}`);
    await checkSniperOpportunity(id, depositAmount, currency, conversionRate, verifier);
  }
  return;
}

if (name === 'DepositConversionRateUpdated') {
  const { depositId, verifier, currency, newConversionRate } = parsed.args;
  const id = Number(depositId);
  const fiatCode = getFiatCode(currency);
  const rate = (Number(newConversionRate) / 1e18).toFixed(6);
  const platform = getPlatformName(verifier);

  console.log(`📶 DepositConversionRateUpdated - ID: ${id}, ${platform}, ${fiatCode} rate updated to ${rate}`);
  
  // Check for sniper opportunity with updated rate
  const depositAmount = await db.getDepositAmount(id);
  if (depositAmount > 0) {
    console.log(`🎯 Rechecking sniper opportunity due to conversion rate update for deposit ${id}`);
    await checkSniperOpportunity(id, depositAmount, currency, newConversionRate, verifier);
  }
  return;
}
    
    
if (name === 'DepositReceived') {
  const { depositId, depositor, token, amount, intentAmountRange } = parsed.args;
  const id = Number(depositId);
  const usdcAmount = Number(amount);
  
  console.log(`💰 DepositReceived: ${id} with ${formatUSDC(amount)} USDC`);
  
  // Store the deposit amount for later sniper use
  await db.storeDepositAmount(id, usdcAmount);
  return;
}

if (name === 'DepositVerifierAdded') {
  const { depositId, verifier, payeeDetailsHash, intentGatingService } = parsed.args;
  const id = Number(depositId);
  
  console.log(`👤 DepositVerifierAdded: deposit ${id}, verifier ${verifier} - ignoring`);
  return;
}

    // NEW: Handle DepositCurrencyAdded for sniper functionality
  if (name === 'DepositCurrencyAdded') {
    const { depositId, verifier, currency, conversionRate } = parsed.args;  
    const id = Number(depositId);
    
    console.log('🎯 DepositCurrencyAdded detected:', id);
    
    // Get the actual deposit amount
    const depositAmount = await db.getDepositAmount(id);
    console.log(`💰 Retrieved deposit amount: ${depositAmount} (${formatUSDC(depositAmount)} USDC)`);
    
    // Check for sniper opportunity with real amount
    await checkSniperOpportunity(id, depositAmount, currency, conversionRate, verifier);
  return;
  }

// Default case: log any other events we don't handle
console.log(`ℹ️ Unhandled Escrow event: ${name} - ignoring`);

  } catch (err) {
    console.error('❌ Failed to parse log:', err.message);
    console.log('👀 Raw log (unparsed):', log);
    console.log('📝 Topics received:', log.topics);
    console.log('📝 First topic (event signature):', log.topics[0]);
    console.log('🔄 Continuing to listen for other events...');
  }
};

// Orchestrator event handler (v2)
const handleOrchestratorEvent = async (log) => {
  console.log('\n📦 Orchestrator event received:');
  console.log(log);

  try {
    const parsed = orchestratorIface.parseLog({ 
      data: log.data, 
      topics: log.topics 
    });
    
    if (!parsed) {
      console.log('⚠️ Orchestrator log format did not match our ABI');
      return;
    }
    
    console.log('✅ Parsed Orchestrator event:', parsed.name);
    console.log('🔍 Args:', parsed.args);

    const { name } = parsed;

    // Governance events we explicitly ignore
    if (name === 'Paused' || name === 'Unpaused' || 
        name === 'OwnershipTransferred' ||
        name === 'EscrowRegistryUpdated' || name === 'PaymentVerifierRegistryUpdated' ||
        name === 'PostIntentHookRegistryUpdated' || name === 'RelayerRegistryUpdated' ||
        name === 'ProtocolFeeUpdated' || name === 'ProtocolFeeRecipientUpdated' ||
        name === 'AllowMultipleIntentsUpdated' || name === 'PartialManualReleaseDelayUpdated') {
      console.log(`👁️ Ignoring governance event: ${name}`);
      return;
    }

    if (name === 'IntentSignaled') {
      const { intentHash, escrow, depositId, paymentMethod, owner, to, amount, fiatCurrency, conversionRate, timestamp } = parsed.args;
      const id = Number(depositId);
      const intentHashLower = intentHash.toLowerCase();
      
      console.log('🧪 Orchestrator IntentSignaled - depositId:', id);
      
      // Store intent details for later use
      orchestratorIntentDetails.set(intentHashLower, {
        depositId: id,
        escrow,
        paymentMethod,
        owner,
        to,
        amount,
        fiatCurrency,
        conversionRate,
        timestamp
      });
      
      // Also add to intentDetails for backward compatibility with sniper logic
      intentDetails.set(intentHashLower, { fiatCurrency, conversionRate, verifier: escrow });
      
      // Store deposit amount for sniper checks
      const usdcAmount = Number(amount);
      await db.storeDepositAmount(id, usdcAmount);
      
      // Check for sniper opportunity (orchestrator uses paymentMethod as verifier identifier)
      await checkSniperOpportunity(id, usdcAmount, fiatCurrency, conversionRate, paymentMethod);
      
      const fiatCode = getFiatCode(fiatCurrency);
      const fiatAmount = ((Number(amount) / 1e6) * (Number(conversionRate) / 1e18)).toFixed(2);
      const formattedRate = formatConversionRate(conversionRate, fiatCode);
      
      // Get platform name from payment method hash
      const platformName = getPlatformName(paymentMethod);
      
      const interestedUsers = await db.getUsersInterestedInDeposit(id);
      if (interestedUsers.length === 0) {
        console.log('🚫 Ignored — no users interested in this depositId.');
        return;
      }

      console.log(`📤 Sending to ${interestedUsers.length} users interested in deposit ${id}`);

      const message = `
🟡 *Order Created*
• *Deposit ID:* \`${id}\`
• *Order ID:* \`${intentHash}\`
• *Platform:* ${platformName}
• *Owner:* \`${owner}\`
• *To:* \`${to}\`
• *Amount:* ${formatUSDC(amount)} USDC
• *Fiat Amount:* ${fiatAmount} ${fiatCode} 
• *Rate:* ${formattedRate}
• *Time:* ${formatTimestamp(timestamp)}
• *Block:* ${log.blockNumber}
• *Tx:* [View on BaseScan](${txLink(log.transactionHash)})
`.trim();

      await postToDiscord({
        webhookUrl: process.env.DISCORD_ORDERS_WEBHOOK_URL,
        threadId: process.env.DISCORD_ORDERS_THREAD_ID || null,
        content: toDiscordMarkdown(message),
        components: linkButton(`🔗 View Deposit ${id}`, depositLink(id))
      });

      for (const chatId of interestedUsers) {
        await db.updateDepositStatus(chatId, id, 'signaled', intentHash);
        await db.logEventNotification(chatId, id, 'signaled');
        
        const sendOptions = { 
          parse_mode: 'Markdown', 
          disable_web_page_preview: true,
          reply_markup: createDepositKeyboard(id)
        };
        if (chatId === ZKP2P_GROUP_ID) {
          sendOptions.message_thread_id = ZKP2P_TOPIC_ID;
        }
        bot.sendMessage(chatId, message, sendOptions);
      }
      return;
    }

    if (name === 'IntentFulfilled') {
      const { intentHash, fundsTransferredTo, amount, isManualRelease } = parsed.args;
      const intentHashLower = intentHash.toLowerCase();
      const txHash = log.transactionHash;
      
      console.log('🧪 Orchestrator IntentFulfilled collected for batching - intentHash:', intentHash);
      
      // Initialize transaction data if not exists
      if (!pendingTransactions.has(txHash)) {
        pendingTransactions.set(txHash, {
          fulfilled: new Set(),
          pruned: new Set(),
          blockNumber: log.blockNumber,
          rawIntents: new Map()
        });
      }
      
      // Store the fulfillment data
      const txData = pendingTransactions.get(txHash);
      txData.fulfilled.add(intentHashLower);
      txData.rawIntents.set(intentHashLower, {
        eventType: 'orchestrator',
        type: 'fulfilled',
        intentHash,
        fundsTransferredTo,
        amount,
        isManualRelease
      });
      
      // Schedule processing this transaction
      scheduleTransactionProcessing(txHash);
      return;
    }

    if (name === 'IntentPruned') {
      const { intentHash } = parsed.args;
      const intentHashLower = intentHash.toLowerCase();
      const txHash = log.transactionHash;
      
      console.log('🧪 Orchestrator IntentPruned collected for batching - intentHash:', intentHash);
      
      // Initialize transaction data if not exists
      if (!pendingTransactions.has(txHash)) {
        pendingTransactions.set(txHash, {
          fulfilled: new Set(),
          pruned: new Set(),
          blockNumber: log.blockNumber,
          rawIntents: new Map()
        });
      }
      
      // Store the pruned data
      const txData = pendingTransactions.get(txHash);
      txData.pruned.add(intentHashLower);
      txData.rawIntents.set(intentHashLower, {
        eventType: 'orchestrator',
        type: 'pruned',
        intentHash
      });
      
      // Schedule processing this transaction
      scheduleTransactionProcessing(txHash);
      return;
    }

    // Default case: log any other events we don't handle
    console.log(`ℹ️ Unhandled Orchestrator event: ${name} - ignoring`);
    return;

  } catch (err) {
    console.error('❌ Failed to parse Orchestrator log:', err.message);
    console.log('👀 Raw log (unparsed):', log);
    console.log('📝 Topics received:', log.topics);
    console.log('🔄 Continuing to listen for other events...');
  }
};

// Initialize WebSocket provider for Escrow contract (legacy events)
const resilientProvider = new ResilientWebSocketProvider(
  process.env.BASE_RPC,
  escrowContractAddress,
  handleContractEvent
);

// Initialize WebSocket provider for Orchestrator contract (v2 events)
const orchestratorProvider = new ResilientWebSocketProvider(
  process.env.BASE_RPC,
  orchestratorContractAddress,
  handleOrchestratorEvent
);

// Add startup message
console.log('🤖 ZKP2P Telegram Bot Started (Supabase Integration with Auto-Reconnect + Sniper)');
console.log('🔍 Listening for contract events...');
console.log(`📡 Escrow Contract (v1): ${escrowContractAddress}`);
console.log(`📡 Orchestrator Contract (v2): ${orchestratorContractAddress}`);

// Improved graceful shutdown with proper cleanup
const gracefulShutdown = async (signal) => {
  console.log(`🔄 Received ${signal}, shutting down gracefully...`);
  
  try {
    // Stop accepting new connections
    if (resilientProvider) {
      await resilientProvider.destroy();
    }
    
    if (orchestratorProvider) {
      await orchestratorProvider.destroy();
    }
    
    // Stop the Telegram bot
    if (bot) {
      console.log('🛑 Stopping Telegram bot...');
      await bot.stopPolling();
    }
    
    // Close database connections (if any)
    console.log('🛑 Cleaning up resources...');
    
    console.log('✅ Graceful shutdown completed');
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Error during shutdown:', error);
    process.exit(1);
  }
};

// Enhanced error handlers
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught exception:', error);
  console.error('Stack trace:', error.stack);
  
  // Attempt to restart WebSocket if it's a connection issue
  if (error.message.includes('WebSocket') || error.message.includes('ECONNRESET')) {
    console.log('🔄 Attempting to restart WebSocket due to connection error...');
    if (resilientProvider) {
      resilientProvider.restart();
    }
    if (orchestratorProvider) {
      orchestratorProvider.restart();
    }
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled rejection at:', promise, 'reason:', reason);
  
  // Attempt to restart WebSocket if it's a connection issue
  if (reason && reason.message && 
      (reason.message.includes('WebSocket') || reason.message.includes('ECONNRESET'))) {
    console.log('🔄 Attempting to restart WebSocket due to rejection...');
    if (resilientProvider) {
      resilientProvider.restart();
    }
    if (orchestratorProvider) {
      orchestratorProvider.restart();
    }
  }
});

// Graceful shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Health check interval
setInterval(async () => {
  if (resilientProvider && !resilientProvider.isConnected) {
    console.log('🔍 Health check: Escrow WebSocket disconnected, attempting restart...');
    await resilientProvider.restart();
  }
  if (orchestratorProvider && !orchestratorProvider.isConnected) {
    console.log('🔍 Health check: Orchestrator WebSocket disconnected, attempting restart...');
    await orchestratorProvider.restart();
  }
}, 120000); // Check every two minutes
