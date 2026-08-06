require('dotenv').config();
const { JsonRpcProvider, Contract, Interface } = require('ethers');
const { TelegramBot } = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const {
  CONTRACT_ADDRESSES,
  SUPPORTED_SNIPER_PLATFORMS,
  escrowAbi,
  escrowV2Abi,
  getPlatformName,
  legacyEscrowAbi,
  modernOrchestratorAbi,
  orchestratorAbi
} = require('./src/contracts');
const {
  buildOrderCreatedMessage,
  buildOrderStatusMessage,
  buildSniperMessage,
  createPeerlyticsKeyboard,
  peerlyticsDepositUrl,
  peerlyticsIntentUrl
} = require('./src/alerts');
const { ResilientWebSocketProvider } = require('./src/resilient-websocket-provider');

// Supabase setup
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// Exchange rate API configuration
const EXCHANGE_API_URL = `https://v6.exchangerate-api.com/v6/${process.env.EXCHANGE_API_KEY}/latest/USD`;

const depositAmounts = new Map(); // Store deposit amounts temporarily
const recentSniperAlerts = new Map(); // depositId -> timestamp, dedup alerts within 30s
const intentDetails = new Map();
const orchestratorIntentDetails = new Map(); // intentHash -> {depositId, escrow, paymentMethod, owner, to, amount, fiatCurrency, conversionRate, timestamp}

// Separate in-memory deposit amount caches for new escrow contracts to avoid
// deposit ID collisions with the legacy escrow (independent ID counters)
const escrowV2DepositAmounts = new Map(); // depositId -> amount
const escrowV3DepositAmounts = new Map(); // depositId -> amount

// Oracle adapter support for V2/V3 escrow contracts
const baseHttpProvider = new JsonRpcProvider('https://mainnet.base.org');
const oracleAdapterAbi = [
  'function getRate(bytes calldata normalizedConfig) external view returns (bool valid, uint256 rate, uint256 updatedAt)'
];
// Cache oracle configs: "depositId-paymentMethod-currency" -> { adapter, adapterConfig, spreadBps }
const escrowV2OracleConfigs = new Map();

// Database helper functions
class DatabaseManager {
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
    
    const { error: error1 } = await supabase
      .from('user_deposits')
      .update({ 
        is_active: false,
        updated_at: timestamp
      })
      .eq('chat_id', chatId);
    
    const { error: error2 } = await supabase
      .from('user_settings')
      .update({ 
        is_active: false,
        updated_at: timestamp
      })
      .eq('chat_id', chatId);

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
    const { data: allListeners } = await supabase
      .from('user_settings')
      .select('chat_id')
      .eq('listen_all', true)
      .eq('is_active', true); // Only active "listen all" users
    
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

    const unique = new Map();
    data.forEach(row => {
      const key = `${row.currency}-${row.platform ?? 'all'}`;
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

    if (platform) {
      query = query.or(`platform.eq.${platform.toLowerCase()},platform.is.null`);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching users with sniper:', error);
      return [];
    }

    const userMap = new Map();
    data.forEach(row => {
      const existing = userMap.get(row.chat_id);
      if (!existing || new Date(row.created_at) > new Date(existing.created_at)) {
        userMap.set(row.chat_id, row);
      }
    });

    return Array.from(userMap.keys());
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
    depositAmounts.set(Number(depositId), Number(amount));

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
    const memoryAmount = depositAmounts.get(Number(depositId));
    if (memoryAmount) return memoryAmount;

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
    return data?.threshold || 0.2;
  }

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


const {
  legacyEscrow: escrowContractAddress,
  escrow: escrowV3ContractAddress,
  escrowV2: escrowV2ContractAddress,
  orchestrator: orchestratorContractAddress,
  orchestratorV2: orchestratorV2ContractAddress,
  orchestratorV3: orchestratorV3ContractAddress
} = CONTRACT_ADDRESSES;

const iface = new Interface(legacyEscrowAbi);
const orchestratorIface = new Interface(orchestratorAbi);
const escrowV3Iface = new Interface(escrowAbi);
const escrowV2Iface = new Interface(escrowV2Abi);
const orchestratorV2Iface = new Interface(modernOrchestratorAbi);
const pendingTransactions = new Map(); // txHash -> {fulfilled: Set, pruned: Set, blockNumber: number, rawIntents: Map}
const processingScheduled = new Set(); // Track which transactions are scheduled for processing

function scheduleTransactionProcessing(txHash) {
  if (processingScheduled.has(txHash)) return; // Already scheduled
  
  processingScheduled.add(txHash);
  
  setTimeout(() => {
    processCompletedTransaction(txHash)
      .catch((error) => console.error(`Failed to process transaction ${txHash}:`, error))
      .finally(() => processingScheduled.delete(txHash));
  }, 10000); // Wait 10 seconds for all events to arrive
}

async function processCompletedTransaction(txHash) {
  const txData = pendingTransactions.get(txHash);
  if (!txData) return;
  
  try {
    console.log(`🔄 Processing completed transaction ${txHash}`);

    // Process pruned intents first, but skip if also fulfilled
    for (const intentHash of txData.pruned) {
      if (txData.fulfilled.has(intentHash)) {
        console.log(`Intent ${intentHash} was both pruned and fulfilled in tx ${txHash}, prioritizing fulfilled status`);
        continue;
      }

      const rawIntent = txData.rawIntents.get(intentHash);
      if (rawIntent?.eventType === 'orchestrator') {
        await sendOrchestratorPrunedNotification(rawIntent);
      } else if (rawIntent) {
        await sendPrunedNotification(rawIntent);
      }
    }

    for (const intentHash of txData.fulfilled) {
      const rawIntent = txData.rawIntents.get(intentHash);
      if (rawIntent?.eventType === 'orchestrator') {
        await sendOrchestratorFulfilledNotification(rawIntent);
      } else if (rawIntent) {
        await sendFulfilledNotification(rawIntent);
      }
    }
  } finally {
    pendingTransactions.delete(txHash);
  }
}

async function sendFulfilledNotification(rawIntent) {
  const { depositId, verifier, amount, intentHash } = rawIntent;
  const storedDetails = intentDetails.get(intentHash.toLowerCase());
  intentDetails.delete(intentHash.toLowerCase());
  
  const interestedUsers = await db.getUsersInterestedInDeposit(depositId);
  if (interestedUsers.length === 0) return;
  
  console.log(`📤 Sending fulfillment to ${interestedUsers.length} users interested in deposit ${depositId}`);
  
  const message = buildOrderStatusMessage({
    status: 'fulfilled',
    platform: getPlatformName(storedDetails?.verifier || verifier),
    amount,
    conversionRate: storedDetails?.conversionRate,
    currencyCode: storedDetails ? getFiatCode(storedDetails.fiatCurrency) : null
  });
  const peerlyticsUrl = peerlyticsIntentUrl(intentHash);

  await postToDiscord({
    webhookUrl: process.env.DISCORD_ORDERS_WEBHOOK_URL,
    threadId: process.env.DISCORD_ORDERS_THREAD_ID || null,
    content: toDiscordMarkdown(message),
    components: linkButton('View on Peerlytics', peerlyticsUrl)
  });


  for (const chatId of interestedUsers) {
    await db.updateDepositStatus(chatId, depositId, 'fulfilled', intentHash);
    await db.logEventNotification(chatId, depositId, 'fulfilled');
    
    const sendOptions = { 
      parse_mode: 'Markdown', 
      disable_web_page_preview: true,
      reply_markup: createPeerlyticsKeyboard(peerlyticsUrl)
    };
    if (chatId === ZKP2P_GROUP_ID) {
      sendOptions.message_thread_id = ZKP2P_TOPIC_ID;
    }
    bot.sendMessage(chatId, message, sendOptions);
  }
}

async function sendPrunedNotification(rawIntent) {
  const { depositId, intentHash } = rawIntent;
  const storedDetails = intentDetails.get(intentHash.toLowerCase());
  intentDetails.delete(intentHash.toLowerCase());
  
  const interestedUsers = await db.getUsersInterestedInDeposit(depositId);
  if (interestedUsers.length === 0) return;
  
  console.log(`📤 Sending cancellation to ${interestedUsers.length} users interested in deposit ${depositId}`);
  
  const message = buildOrderStatusMessage({
    status: 'cancelled',
    platform: getPlatformName(storedDetails?.verifier),
    amount: storedDetails?.amount,
    conversionRate: storedDetails?.conversionRate,
    currencyCode: storedDetails ? getFiatCode(storedDetails.fiatCurrency) : null
  });
  const peerlyticsUrl = peerlyticsIntentUrl(intentHash);

  await postToDiscord({
    webhookUrl: process.env.DISCORD_ORDERS_WEBHOOK_URL,
    threadId: process.env.DISCORD_ORDERS_THREAD_ID || null,
    content: toDiscordMarkdown(message),
    components: linkButton('View on Peerlytics', peerlyticsUrl)
  });


  for (const chatId of interestedUsers) {
    await db.updateDepositStatus(chatId, depositId, 'pruned', intentHash);
    await db.logEventNotification(chatId, depositId, 'pruned');
    
    const sendOptions = { 
      parse_mode: 'Markdown', 
      disable_web_page_preview: true,
      reply_markup: createPeerlyticsKeyboard(peerlyticsUrl)
    };
    if (chatId === ZKP2P_GROUP_ID) {
      sendOptions.message_thread_id = ZKP2P_TOPIC_ID;
    }
    bot.sendMessage(chatId, message, sendOptions);
  }
}

async function sendOrchestratorFulfilledNotification(rawIntent) {
  const { intentHash, amount } = rawIntent;
  const intentHashLower = intentHash.toLowerCase();
  
  // Get stored intent details
  const storedDetails = orchestratorIntentDetails.get(intentHashLower);
  if (!storedDetails) {
    console.log('⚠️ No stored details for intent:', intentHash);
    return;
  }
  
  const oldIntentDetails = intentDetails.get(intentHashLower);
  const depositId = storedDetails.depositId;
  const { fiatCurrency, conversionRate, paymentMethod } = storedDetails;
  
  // Try to get platform name from payment method first (Orchestrator v2/v3), fallback to verifier address
  const platformName = getPlatformName(paymentMethod || oldIntentDetails?.verifier);
  orchestratorIntentDetails.delete(intentHashLower);
  intentDetails.delete(intentHashLower);

  const interestedUsers = await db.getUsersInterestedInDeposit(depositId);
  if (interestedUsers.length === 0) return;

  console.log(`📤 Sending fulfillment to ${interestedUsers.length} users interested in deposit ${depositId}`);

  const message = buildOrderStatusMessage({
    status: 'fulfilled',
    platform: platformName,
    amount,
    conversionRate,
    currencyCode: getFiatCode(fiatCurrency)
  });
  const peerlyticsUrl = peerlyticsIntentUrl(intentHash);

  await postToDiscord({
    webhookUrl: process.env.DISCORD_ORDERS_WEBHOOK_URL,
    threadId: process.env.DISCORD_ORDERS_THREAD_ID || null,
    content: toDiscordMarkdown(message),
    components: linkButton('View on Peerlytics', peerlyticsUrl)
  });

  for (const chatId of interestedUsers) {
    await db.updateDepositStatus(chatId, depositId, 'fulfilled', intentHash);
    await db.logEventNotification(chatId, depositId, 'fulfilled');
    
    const sendOptions = { 
      parse_mode: 'Markdown', 
      disable_web_page_preview: true,
      reply_markup: createPeerlyticsKeyboard(peerlyticsUrl)
    };
    if (chatId === ZKP2P_GROUP_ID) {
      sendOptions.message_thread_id = ZKP2P_TOPIC_ID;
    }
    bot.sendMessage(chatId, message, sendOptions);
  }
}

async function sendOrchestratorPrunedNotification(rawIntent) {
  const { intentHash } = rawIntent;
  const intentHashLower = intentHash.toLowerCase();
  
  // Get stored intent details
  const storedDetails = orchestratorIntentDetails.get(intentHashLower);
  if (!storedDetails) {
    console.log('⚠️ No stored details for intent:', intentHash);
    return;
  }
  
  const depositId = storedDetails.depositId;
  orchestratorIntentDetails.delete(intentHashLower);
  intentDetails.delete(intentHashLower);

  const interestedUsers = await db.getUsersInterestedInDeposit(depositId);
  if (interestedUsers.length === 0) return;

  console.log(`📤 Sending cancellation to ${interestedUsers.length} users interested in deposit ${depositId}`);

  const message = buildOrderStatusMessage({
    status: 'cancelled',
    platform: getPlatformName(storedDetails.paymentMethod || storedDetails.escrow),
    amount: storedDetails.amount,
    conversionRate: storedDetails.conversionRate,
    currencyCode: getFiatCode(storedDetails.fiatCurrency)
  });
  const peerlyticsUrl = peerlyticsIntentUrl(intentHash);

  await postToDiscord({
    webhookUrl: process.env.DISCORD_ORDERS_WEBHOOK_URL,
    threadId: process.env.DISCORD_ORDERS_THREAD_ID || null,
    content: toDiscordMarkdown(message),
    components: linkButton('View on Peerlytics', peerlyticsUrl)
  });

  for (const chatId of interestedUsers) {
    await db.updateDepositStatus(chatId, depositId, 'pruned', intentHash);
    await db.logEventNotification(chatId, depositId, 'pruned');
    
    const sendOptions = { 
      parse_mode: 'Markdown', 
      disable_web_page_preview: true,
      reply_markup: createPeerlyticsKeyboard(peerlyticsUrl)
    };
    if (chatId === ZKP2P_GROUP_ID) {
      sendOptions.message_thread_id = ZKP2P_TOPIC_ID;
    }
    bot.sendMessage(chatId, message, sendOptions);
  }
}




// Helper functions
const formatUSDC = (amount) => (Number(amount) / 1e6).toFixed(2);
const txLink = (hash) => `https://basescan.org/tx/${hash}`;

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

const createDepositKeyboard = (depositId, escrowAddress = escrowContractAddress) =>
  createPeerlyticsKeyboard(peerlyticsDepositUrl(escrowAddress, depositId));

// Fetch rate from oracle adapter contract
async function getOracleRate(adapterAddress, adapterConfig) {
  try {
    const adapter = new Contract(adapterAddress, oracleAdapterAbi, baseHttpProvider);
    const [valid, rate, updatedAt] = await adapter.getRate(adapterConfig);
    if (!valid) {
      console.log(`⚠️ Oracle adapter ${adapterAddress} returned invalid rate`);
      return null;
    }
    console.log(`🔮 Oracle rate from ${adapterAddress}: ${rate} (updatedAt: ${updatedAt})`);
    return rate; // Already in 1e18 precision
  } catch (err) {
    console.error(`❌ Failed to fetch oracle rate from ${adapterAddress}:`, err.message);
    return null;
  }
}

// Sniper logic
async function checkSniperOpportunity(
  depositId,
  depositAmount,
  currencyHash,
  conversionRate,
  verifierAddress,
  escrowAddress
) {
  // Dedup: skip if we already alerted this deposit+currency in the last 30s
  const now = Date.now();
  const dedupKey = `${String(escrowAddress).toLowerCase()}-${depositId}-${currencyHash}`;
  const lastAlert = recentSniperAlerts.get(dedupKey);
  if (lastAlert && now - lastAlert < 30000) {
    console.log(`⏭️ Skipping duplicate sniper check for deposit ${depositId} (alerted ${((now - lastAlert) / 1000).toFixed(1)}s ago)`);
    return;
  }

  const currencyCode = currencyHashToCode[currencyHash.toLowerCase()];
  const platformName = getPlatformName(verifierAddress).toLowerCase();

  if (!currencyCode) {
    console.log(`⚠️ Unknown currency hash: ${currencyHash}, skipping sniper check`);
    return; // Only skip unknown currencies
  }
  
  // Check if deposit amount is valid
  if (!depositAmount || Number(depositAmount) <= 0) {
    console.log(`⚠️ Invalid deposit amount for deposit ${depositId}: ${depositAmount}, skipping sniper check`);
    return;
  }
  
  console.log(`🎯 Checking sniper opportunity for deposit ${depositId}, currency: ${currencyCode}, amount: ${(Number(depositAmount) / 1e6).toFixed(2)} USDC`);
  
  // Get market rate - use CriptoYa API for ARS, otherwise use standard exchange API
  let marketRate;
  if (currencyCode === 'ARS') {
    marketRate = await getARSRate();
    if (!marketRate) {
      console.log('❌ No ARS rate available from CriptoYa');
      return;
    }
  } else if (currencyCode === 'USD') {
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
  
// Mark this deposit+currency as alerted to prevent duplicate notifications
recentSniperAlerts.set(dedupKey, Date.now());

// Get users with their custom thresholds and check each one individually
const interestedUsers = await db.getUsersWithSniper(currencyCode, platformName);

if (!interestedUsers.includes(ZKP2P_GROUP_ID)) {
  interestedUsers.push(ZKP2P_GROUP_ID);
}

if (interestedUsers.length > 0) {
  console.log(`🎯 Checking thresholds for ${interestedUsers.length} potential users`);
  
  for (const chatId of interestedUsers) {
    const userThreshold = await db.getUserThreshold(chatId);
    const isOneToOne = Math.abs(percentageDiff) < 0.1; // Within 0.1% of market rate = parity

    // 1:1 deposits always alert (bypass threshold), otherwise check user threshold
    const shouldAlert = isOneToOne || percentageDiff >= userThreshold;

    console.log(`📊 User ${chatId}: threshold=${userThreshold}%, diff=${percentageDiff.toFixed(2)}%, isOneToOne=${isOneToOne}, shouldAlert=${shouldAlert}`);

    if (shouldAlert) {
      console.log(`🎯 ${isOneToOne ? '1:1 DEPOSIT' : 'SNIPER OPPORTUNITY'} for user ${chatId}! diff=${percentageDiff.toFixed(2)}%`);

      const message = buildSniperMessage({
        platform: platformName,
        amount: depositAmount,
        conversionRate,
        currencyCode,
        percentageDiff,
        isOneToOne,
        timestamp: new Date(now)
      });
      const peerlyticsUrl = peerlyticsDepositUrl(escrowAddress, depositId);

      await db.logSniperAlert(chatId, depositId, currencyCode, depositRate, marketRate, percentageDiff);

const sendOptions = {
  parse_mode: 'Markdown',
  disable_web_page_preview: true,
  reply_markup: createPeerlyticsKeyboard(peerlyticsUrl)
};

// 1:1 alerts go to the main deposit channels, sniper alerts go to sniper channels
if (chatId === ZKP2P_GROUP_ID) {
  sendOptions.message_thread_id = ZKP2P_SNIPER_TOPIC_ID;
}

await postToDiscord({
  webhookUrl: process.env.DISCORD_SNIPER_WEBHOOK_URL,
  threadId: process.env.DISCORD_SNIPER_THREAD_ID || null,
  content: toDiscordMarkdown(message),
  components: linkButton('View on Peerlytics', peerlyticsUrl)
});


await bot.sendMessage(chatId, message, sendOptions);
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
    const eventStreamStatus = eventProvider?.isConnected ? '🟢 Connected' : '🔴 Disconnected';
    let dbStatus = '🔴 Disconnected';
    let botStatus = '🔴 Disconnected';

    try {
      const { error } = await supabase.from('users').select('chat_id').limit(1);
      if (!error) dbStatus = '🟢 Connected';
    } catch (error) {
      console.error('Database status check failed:', error.message);
    }

    try {
      await bot.getMe();
      botStatus = '🟢 Connected';
    } catch (error) {
      console.error('Telegram status check failed:', error.message);
    }

    const listeningAll = await db.getUserListenAll(chatId);
    const trackedCount = (await db.getUserDeposits(chatId)).size;
    const snipers = await db.getUserSnipers(chatId);

    let message = `🔧 *System Status:*

• *Base event stream:* ${eventStreamStatus}
• *Contracts monitored:* ${contractSubscriptions.length} (including OrchestratorV3)
• *Database:* ${dbStatus}
• *Telegram:* ${botStatus}

📊 *Your Settings:*
• *Listening to:* ${listeningAll ? 'ALL deposits' : `${trackedCount} specific deposits`}
`;

    if (snipers.length > 0) {
      const sniperTexts = snipers.map(({ currency, platform }) =>
        `${currency}${platform ? ` on ${platform}` : ''}`
      );
      message += `• *Sniping:* ${sniperTexts.join(', ')}\n`;
    }

    if (!eventProvider?.isConnected) {
      message += `\n⚠️ *Reconnection attempts:* ${eventProvider.reconnectAttempts}/${eventProvider.maxReconnectAttempts}`;
    }

    await bot.sendMessage(chatId, message.trim(), { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Status command failed:', error);
    await bot.sendMessage(chatId, '❌ Failed to get status');
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
  const supportedPlatforms = SUPPORTED_SNIPER_PLATFORMS;
  
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

const helpMessage = `
🤖 *ZKP2P Tracker Commands:*

**Deposit Tracking:**
• \`/deposit all\` - Listen to ALL deposits (every event)
• \`/deposit stop\` - Stop listening to all deposits
• \`/deposit 123\` - Track a specific deposit
• \`/deposit 123,456,789\` - Track multiple deposits
• \`/remove 123\` - Stop tracking specific deposit(s)

**Sniper (Arbitrage Alerts):**
• \`/sniper eur\` - Snipe EUR on ALL platforms
• \`/sniper eur revolut\` - Snipe EUR only on Revolut
• \`/sniper usd zelle\` - Snipe USD only on Zelle
• \`/sniper threshold 0.5\` - Set your alert threshold to 0.5%
• \`/sniper list\` - Show active sniper settings
• \`/sniper clear\` - Clear all sniper settings
• \`/unsnipe eur\` - Stop sniping EUR (all platforms)
• \`/unsnipe eur wise\` - Stop sniping EUR on Wise only

**General:**
• \`/list\` - Show all tracking status (deposits + snipers)
• \`/clearall\` - Stop all tracking and clear everything
• \`/status\` - Check WebSocket connection and settings
• \`/help\` - Show this help message

*Note: Each user has their own settings. Sniper alerts you when deposits offer better exchange rates than market!*
`.trim();

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, helpMessage, { parse_mode: 'Markdown' });
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id, helpMessage, { parse_mode: 'Markdown' });
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
      const { intentHash, depositId, verifier, amount, fiatCurrency, conversionRate, timestamp } = parsed.args;
      const id = Number(depositId);
      const fiatCode = getFiatCode(fiatCurrency);
      const platformName = getPlatformName(verifier);
      
      console.log('🧪 IntentSignaled depositId:', id);
      
      intentDetails.set(intentHash.toLowerCase(), {
        fiatCurrency,
        conversionRate,
        verifier,
        amount,
        timestamp
      });
      
      const interestedUsers = await db.getUsersInterestedInDeposit(id);
      if (interestedUsers.length === 0) {
        console.log('🚫 Ignored — no users interested in this depositId.');
        return;
      }

      console.log(`📤 Sending to ${interestedUsers.length} users interested in deposit ${id}`);

      const message = buildOrderCreatedMessage({
        platform: platformName,
        amount,
        conversionRate,
        currencyCode: fiatCode,
        timestamp
      });
      const peerlyticsUrl = peerlyticsIntentUrl(intentHash);

      await postToDiscord({
        webhookUrl: process.env.DISCORD_ORDERS_WEBHOOK_URL,
        threadId: process.env.DISCORD_ORDERS_THREAD_ID || null,
        content: toDiscordMarkdown(message),
        components: linkButton('View on Peerlytics', peerlyticsUrl)
      });


      for (const chatId of interestedUsers) {
        await db.updateDepositStatus(chatId, id, 'signaled', intentHash);
        await db.logEventNotification(chatId, id, 'signaled');
        
        const sendOptions = { 
          parse_mode: 'Markdown', 
          disable_web_page_preview: true,
          reply_markup: createPeerlyticsKeyboard(peerlyticsUrl)
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
    await checkSniperOpportunity(
      id,
      depositAmount,
      currency,
      conversionRate,
      verifier,
      escrowContractAddress
    );
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
    await checkSniperOpportunity(
      id,
      depositAmount,
      currency,
      newConversionRate,
      verifier,
      escrowContractAddress
    );
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

  if (name === 'DepositCurrencyAdded') {
    const { depositId, verifier, currency, conversionRate } = parsed.args;  
    const id = Number(depositId);
    const fiatCode = getFiatCode(currency);
    
    console.log(`🎯 DepositCurrencyAdded detected: deposit ${id}, currency: ${fiatCode}`);
    
    // Get the actual deposit amount
    const depositAmount = await db.getDepositAmount(id);
    console.log(`💰 Retrieved deposit amount: ${depositAmount} (${formatUSDC(depositAmount)} USDC)`);
    
    // If deposit amount is not available yet, log and skip (it will be checked on rate updates)
    if (!depositAmount || Number(depositAmount) <= 0) {
      console.log(`⚠️ Deposit amount not available yet for deposit ${id}, will check on rate updates`);
      return;
    }
    
    // Check for sniper opportunity with real amount
    await checkSniperOpportunity(
      id,
      depositAmount,
      currency,
      conversionRate,
      verifier,
      escrowContractAddress
    );
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

// V3 Escrow event handler - only processes deposit-related events
const handleEscrowV3Event = async (log) => {
  // Only process events from V3 Escrow contract
  if (log.address.toLowerCase() !== escrowV3ContractAddress.toLowerCase()) {
    return; // Ignore events from other contracts
  }

  try {
    const parsed = escrowV3Iface.parseLog({ 
      data: log.data, 
      topics: log.topics 
    });
    
    // If event doesn't match our ABI, silently ignore it (likely not a deposit event)
    if (!parsed) {
      return;
    }
    
    const { name } = parsed;

    // Only handle these three deposit-related events - ignore everything else silently
    if (name === 'DepositReceived') {
      const { depositId, amount } = parsed.args;
      const id = Number(depositId);
      const usdcAmount = Number(amount);

      console.log(`💰 V3 Escrow DepositReceived: ${id} with ${formatUSDC(amount)} USDC`);

      // Store in-memory (not DB) to avoid collision with legacy escrow deposit IDs
      escrowV3DepositAmounts.set(id, usdcAmount);
      return;
    }

    if (name === 'DepositCurrencyAdded') {
      const { depositId, paymentMethod, currency, minConversionRate } = parsed.args;
      const id = Number(depositId);
      const fiatCode = getFiatCode(currency);

      console.log(`🎯 V3 Escrow DepositCurrencyAdded detected: deposit ${id}, currency: ${fiatCode}, minConversionRate: ${minConversionRate}`);

      // Read from in-memory cache (not DB) to avoid deposit ID collision
      const depositAmount = escrowV3DepositAmounts.get(id) || 0;
      console.log(`💰 Retrieved deposit amount: ${depositAmount} (${formatUSDC(depositAmount)} USDC)`);

      if (!depositAmount || Number(depositAmount) <= 0) {
        console.log(`⚠️ Deposit amount not available yet for deposit ${id}, will check on rate updates`);
        return;
      }

      // Skip oracle-priced deposits (V3 doesn't support oracle config events)
      if (Number(minConversionRate) < 1e10) {
        console.log(`⚠️ V3 deposit ${id} has very low minConversionRate (${minConversionRate}), likely oracle-priced - skipping`);
        return;
      }

      await checkSniperOpportunity(
        id,
        depositAmount,
        currency,
        minConversionRate,
        paymentMethod,
        escrowV3ContractAddress
      );
      return;
    }

    if (name === 'DepositPaymentMethodAdded') {
      // This event is deposit-related but we don't need to do anything with it
      // Silently ignore - we only care about DepositReceived and DepositCurrencyAdded
      return;
    }

    // All other parsed events are ignored silently (shouldn't happen with our ABI, but just in case)
    return;

  } catch (err) {
    // Silently ignore parsing errors - these are likely non-deposit events we don't care about
    return;
  }
};

// EscrowV2 event handler (new contract - uses in-memory deposit cache to avoid ID collision)
const handleEscrowV2Event = async (log) => {
  if (log.address.toLowerCase() !== escrowV2ContractAddress.toLowerCase()) {
    return;
  }

  try {
    const parsed = escrowV2Iface.parseLog({
      data: log.data,
      topics: log.topics
    });

    if (!parsed) return;

    const { name } = parsed;

    if (name === 'DepositReceived') {
      const { depositId, amount } = parsed.args;
      const id = Number(depositId);
      console.log(`💰 EscrowV2 DepositReceived: ${id} with ${formatUSDC(amount)} USDC`);
      escrowV2DepositAmounts.set(id, Number(amount));
      return;
    }

    if (name === 'DepositFundsAdded') {
      const { depositId, amount } = parsed.args;
      const id = Number(depositId);
      console.log(`💰 EscrowV2 DepositFundsAdded: ${id} with ${formatUSDC(amount)} USDC added`);
      const existing = escrowV2DepositAmounts.get(id) || 0;
      escrowV2DepositAmounts.set(id, existing + Number(amount));
      return;
    }

    if (name === 'DepositCurrencyAdded') {
      const { depositId, paymentMethod, currency, minConversionRate } = parsed.args;
      const id = Number(depositId);
      const fiatCode = getFiatCode(currency);
      console.log(`🎯 EscrowV2 DepositCurrencyAdded detected: deposit ${id}, currency: ${fiatCode}, minConversionRate: ${minConversionRate}`);

      const depositAmount = escrowV2DepositAmounts.get(id) || 0;
      console.log(`💰 Retrieved deposit amount: ${depositAmount} (${formatUSDC(depositAmount)} USDC)`);

      if (!depositAmount || Number(depositAmount) <= 0) {
        console.log(`⚠️ Deposit amount not available yet for deposit ${id}`);
        return;
      }

      // If minConversionRate is very low, this deposit uses oracle pricing.
      // The actual rate will come from the DepositOracleRateConfigSet event.
      if (Number(minConversionRate) < 1e10) {
        console.log(`⏳ Deposit ${id} uses oracle pricing (minConversionRate=${minConversionRate}), waiting for oracle config event`);
        return;
      }

      await checkSniperOpportunity(
        id,
        depositAmount,
        currency,
        minConversionRate,
        paymentMethod,
        escrowV2ContractAddress
      );
      return;
    }

    if (name === 'DepositMinConversionRateUpdated') {
      const { depositId, paymentMethod, currency, newMinConversionRate } = parsed.args;
      const id = Number(depositId);
      const fiatCode = getFiatCode(currency);
      const platform = getPlatformName(paymentMethod);
      console.log(`📶 EscrowV2 DepositMinConversionRateUpdated - ID: ${id}, ${platform}, ${fiatCode}`);

      const depositAmount = escrowV2DepositAmounts.get(id) || 0;
      if (depositAmount > 0) {
        await checkSniperOpportunity(
          id,
          depositAmount,
          currency,
          newMinConversionRate,
          paymentMethod,
          escrowV2ContractAddress
        );
      }
      return;
    }

    if (name === 'DepositOracleRateConfigSet') {
      const { depositId, paymentMethod, currencyCode, adapter, adapterConfig, spreadBps } = parsed.args;
      const id = Number(depositId);
      const spread = Number(spreadBps);
      const fiatCode = getFiatCode(currencyCode);
      console.log(`🔮 EscrowV2 DepositOracleRateConfigSet: deposit ${id}, ${fiatCode}, adapter: ${adapter}, spread: ${spread}bps`);

      // Store oracle config for this deposit
      const configKey = `${id}-${paymentMethod}-${currencyCode}`;
      escrowV2OracleConfigs.set(configKey, { adapter, adapterConfig, spreadBps: spread });

      const depositAmount = escrowV2DepositAmounts.get(id) || 0;
      if (!depositAmount || depositAmount <= 0) {
        console.log(`⚠️ Deposit amount not available for oracle deposit ${id}`);
        return;
      }

      // Fetch the actual rate from the oracle adapter
      const oracleRate = await getOracleRate(adapter, adapterConfig);
      if (!oracleRate) {
        console.log(`⚠️ Could not fetch oracle rate for deposit ${id}, skipping sniper check`);
        return;
      }

      // Apply spread: effectiveRate = oracleRate * (10000 + spreadBps) / 10000
      const effectiveRate = (BigInt(oracleRate) * BigInt(10000 + spread)) / 10000n;
      console.log(`📊 Oracle effective rate for deposit ${id}: ${effectiveRate} (oracle: ${oracleRate}, spread: ${spread}bps)`);

      // Pass effective rate to sniper check (already in 1e18 format)
      await checkSniperOpportunity(
        id,
        depositAmount,
        currencyCode,
        effectiveRate,
        paymentMethod,
        escrowV2ContractAddress
      );
      return;
    }

    if (name === 'DepositClosed') {
      const { depositId } = parsed.args;
      escrowV2DepositAmounts.delete(Number(depositId));
      return;
    }

    // DepositWithdrawn, DepositPaymentMethodAdded, etc. - silently ignore
    return;

  } catch (err) {
    return; // Silently ignore parse errors
  }
};

function collectOrchestratorTerminalEvent(log, parsed, eventType) {
  const { intentHash } = parsed.args;
  const intentHashLower = intentHash.toLowerCase();
  const txHash = log.transactionHash;

  if (!pendingTransactions.has(txHash)) {
    pendingTransactions.set(txHash, {
      fulfilled: new Set(),
      pruned: new Set(),
      blockNumber: log.blockNumber,
      rawIntents: new Map()
    });
  }

  const txData = pendingTransactions.get(txHash);
  txData[eventType === 'fulfilled' ? 'fulfilled' : 'pruned'].add(intentHashLower);
  txData.rawIntents.set(intentHashLower, {
    eventType: 'orchestrator',
    type: eventType,
    intentHash,
    ...(eventType === 'fulfilled' ? {
      fundsTransferredTo: parsed.args.fundsTransferredTo,
      amount: parsed.args.amount,
      isManualRelease: parsed.args.isManualRelease
    } : {})
  });
  scheduleTransactionProcessing(txHash);
}

function createOrchestratorEventHandler(sourceLabel, eventInterface) {
  return async (log) => {
    try {
      const parsed = eventInterface.parseLog({ data: log.data, topics: log.topics });
      if (!parsed) return;

      const { name } = parsed;
      if (
        name === 'IntentManagerFeeSnapshotted' ||
        name === 'IntentReferralFeeDistributed' ||
        name === 'IntentLifecycleHookSnapshotted'
      ) {
        return;
      }

      if (name === 'IntentSignaled') {
        const {
          intentHash,
          escrow,
          depositId,
          paymentMethod,
          owner,
          to,
          amount,
          fiatCurrency,
          conversionRate,
          timestamp
        } = parsed.args;
        const id = Number(depositId);
        const intentHashLower = intentHash.toLowerCase();
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
        intentDetails.set(intentHashLower, {
          fiatCurrency,
          conversionRate,
          verifier: paymentMethod,
          amount,
          timestamp
        });

        const interestedUsers = await db.getUsersInterestedInDeposit(id);
        if (interestedUsers.length === 0) return;

        const fiatCode = getFiatCode(fiatCurrency);
        const message = buildOrderCreatedMessage({
          platform: getPlatformName(paymentMethod),
          amount,
          conversionRate,
          currencyCode: fiatCode,
          timestamp
        });
        const peerlyticsUrl = peerlyticsIntentUrl(intentHash);

        await postToDiscord({
          webhookUrl: process.env.DISCORD_ORDERS_WEBHOOK_URL,
          threadId: process.env.DISCORD_ORDERS_THREAD_ID || null,
          content: toDiscordMarkdown(message),
          components: linkButton('View on Peerlytics', peerlyticsUrl)
        });

        await Promise.all(interestedUsers.map(async (chatId) => {
          await db.updateDepositStatus(chatId, id, 'signaled', intentHash);
          await db.logEventNotification(chatId, id, 'signaled');
          const sendOptions = {
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
            reply_markup: createPeerlyticsKeyboard(peerlyticsUrl)
          };
          if (chatId === ZKP2P_GROUP_ID) sendOptions.message_thread_id = ZKP2P_TOPIC_ID;
          await bot.sendMessage(chatId, message, sendOptions);
        }));
        return;
      }

      if (name === 'IntentFulfilled') {
        collectOrchestratorTerminalEvent(log, parsed, 'fulfilled');
        return;
      }

      if (name === 'IntentPruned') {
        collectOrchestratorTerminalEvent(log, parsed, 'pruned');
      }
    } catch (error) {
      console.error(`Failed to process ${sourceLabel} log:`, error.message);
    }
  };
}

const handleOrchestratorEvent = createOrchestratorEventHandler('O1', orchestratorIface);
const handleOrchestratorV2Event = createOrchestratorEventHandler('O2', orchestratorV2Iface);
const handleOrchestratorV3Event = createOrchestratorEventHandler('O3', orchestratorV2Iface);

const contractSubscriptions = [
  { name: 'Legacy Escrow', address: escrowContractAddress, handler: handleContractEvent },
  { name: 'Escrow', address: escrowV3ContractAddress, handler: handleEscrowV3Event },
  { name: 'EscrowV2', address: escrowV2ContractAddress, handler: handleEscrowV2Event },
  { name: 'Orchestrator', address: orchestratorContractAddress, handler: handleOrchestratorEvent },
  { name: 'OrchestratorV2', address: orchestratorV2ContractAddress, handler: handleOrchestratorV2Event },
  { name: 'OrchestratorV3', address: orchestratorV3ContractAddress, handler: handleOrchestratorV3Event }
];

const eventProvider = new ResilientWebSocketProvider(process.env.BASE_RPC, contractSubscriptions);

console.log('ZKP2P Telegram Bot started');
for (const subscription of contractSubscriptions) {
  console.log(`Monitoring ${subscription.name}: ${subscription.address}`);
}

let isShuttingDown = false;

async function gracefulShutdown(signal, exitCode = 0) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`Received ${signal}; shutting down`);

  try {
    await eventProvider.destroy();
    await bot.stopPolling();
    console.log('Shutdown complete');
  } catch (error) {
    console.error('Shutdown failed:', error);
    exitCode = 1;
  } finally {
    process.exit(exitCode);
  }
}

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  void gracefulShutdown('uncaughtException', 1);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => void gracefulShutdown('SIGINT'));

setInterval(() => {
  if (!eventProvider.isConnected) {
    console.warn('Base event stream is disconnected; restarting');
    void eventProvider.restart();
  }
}, 120000);

// Clean up stale sniper alert dedup entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [depositId, timestamp] of recentSniperAlerts) {
    if (now - timestamp > 60000) recentSniperAlerts.delete(depositId);
  }
}, 300000);
