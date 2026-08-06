const { WebSocketProvider } = require('ethers');

function createAddressRouter(subscriptions, onError = console.error) {
  if (!Array.isArray(subscriptions) || subscriptions.length === 0) {
    throw new Error('At least one contract subscription is required');
  }

  const routes = new Map();
  for (const subscription of subscriptions) {
    if (!subscription?.name || !subscription?.address || typeof subscription.handler !== 'function') {
      throw new Error('Each subscription requires a name, address, and handler');
    }

    const address = subscription.address.toLowerCase();
    if (routes.has(address)) {
      throw new Error(`Duplicate contract subscription: ${subscription.address}`);
    }
    routes.set(address, { ...subscription, address });
  }

  return {
    addresses: [...routes.keys()],
    async route(log) {
      const subscription = routes.get(log.address.toLowerCase());
      if (!subscription) return false;

      try {
        await subscription.handler(log);
      } catch (error) {
        onError(`Event handler failed for ${subscription.name}:`, error);
      }
      return true;
    }
  };
}

class ResilientWebSocketProvider {
  constructor(url, subscriptions) {
    this.url = url;
    this.subscriptions = subscriptions;
    this.router = createAddressRouter(subscriptions);
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 30000;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 50;
    this.isConnecting = false;
    this.isDestroyed = false;
    this.provider = null;
    this.reconnectTimer = null;
    this.keepAliveTimer = null;
    this.lastActivityTime = Date.now();

    this.connect();
  }

  async connect() {
    if (this.isConnecting || this.isDestroyed) return;
    this.isConnecting = true;

    try {
      console.log(`Attempting Base WebSocket connection (attempt ${this.reconnectAttempts + 1})`);
      if (this.provider) await this.cleanup();

      this.provider = new WebSocketProvider(this.url);
      this.setupEventListeners();

      const timeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Connection timeout')), 15000);
      });
      await Promise.race([this.provider.getNetwork(), timeout]);

      this.lastActivityTime = Date.now();
      this.reconnectAttempts = 0;
      this.reconnectDelay = 1000;
      this.reconnectTimer = null;
      this.isConnecting = false;

      this.setupContractListening();
      this.startKeepAlive();
      console.log(`Base WebSocket connected; monitoring ${this.subscriptions.length} contracts`);
    } catch (error) {
      console.error('Base WebSocket connection failed:', error.message);
      this.isConnecting = false;
      if (!this.isDestroyed) this.scheduleReconnect();
    }
  }

  setupEventListeners() {
    if (!this.provider || this.isDestroyed) return;

    const ws = this.websocket;
    if (ws) {
      ws.on('close', (code, reason) => {
        console.warn(`Base WebSocket closed: ${code} - ${reason}`);
        this.stopKeepAlive();
        if (!this.isDestroyed) this.scheduleReconnect();
      });
      ws.on('error', (error) => {
        console.error('Base WebSocket error:', error.message);
        this.stopKeepAlive();
        if (!this.isDestroyed) this.scheduleReconnect();
      });
      ws.on('ping', (data) => {
        this.lastActivityTime = Date.now();
        ws.pong(data);
      });
      ws.on('pong', () => {
        this.lastActivityTime = Date.now();
      });
      ws.on('message', () => {
        this.lastActivityTime = Date.now();
      });
    }

    this.provider.on('error', (error) => {
      console.error('Base provider error:', error.message);
      if (!this.isDestroyed) this.scheduleReconnect();
    });
  }

  setupContractListening() {
    if (!this.provider || this.isDestroyed) return;

    this.provider.on({ address: this.router.addresses }, (log) => {
      this.lastActivityTime = Date.now();
      void this.router.route(log);
    });
  }

  startKeepAlive() {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      const ws = this.websocket;
      if (!ws || ws.readyState !== 1) return;

      try {
        ws.ping();
        if (Date.now() - this.lastActivityTime > 90000) {
          console.warn('Base WebSocket inactive for 90 seconds; reconnecting');
          this.scheduleReconnect();
        }
      } catch (error) {
        console.error('Base WebSocket keep-alive failed:', error.message);
        this.scheduleReconnect();
      }
    }, 30000);
  }

  stopKeepAlive() {
    if (!this.keepAliveTimer) return;
    clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }

  scheduleReconnect() {
    if (this.isConnecting || this.isDestroyed) return;
    if (this.reconnectTimer) return;
    this.stopKeepAlive();
    this.reconnectAttempts += 1;

    if (this.reconnectAttempts > this.maxReconnectAttempts) {
      console.error(`Max WebSocket reconnection attempts (${this.maxReconnectAttempts}) reached`);
      return;
    }

    const delay = Math.min(
      this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts),
      this.maxReconnectDelay
    );
    console.warn(`Reconnecting Base WebSocket in ${Math.round(delay)}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  async cleanup() {
    this.stopKeepAlive();
    if (!this.provider) return;

    try {
      await this.provider.removeAllListeners();
      const ws = this.websocket;
      if (ws) {
        ws.removeAllListeners();
        if (ws.readyState === 1) ws.close(1000, 'Normal closure');
      }
      if (typeof this.provider.destroy === 'function') await this.provider.destroy();
    } catch (error) {
      console.warn('WebSocket cleanup failed:', error.message);
    }
  }

  async restart() {
    if (this.isConnecting || this.isDestroyed) return;
    this.reconnectAttempts = 0;
    this.reconnectDelay = 1000;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.cleanup();
    this.provider = null;
    await this.connect();
  }

  async destroy() {
    this.isDestroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    await this.cleanup();
    this.provider = null;
  }

  get websocket() {
    try {
      return this.provider?.websocket || null;
    } catch {
      return null;
    }
  }

  get isConnected() {
    const ws = this.websocket;
    return Boolean(
      this.provider &&
      ws &&
      ws.readyState === 1 &&
      Date.now() - this.lastActivityTime < 120000
    );
  }
}

module.exports = { ResilientWebSocketProvider, createAddressRouter };
