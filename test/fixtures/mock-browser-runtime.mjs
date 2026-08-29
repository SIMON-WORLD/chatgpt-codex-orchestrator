// test/fixtures/mock-browser-runtime.mjs
// Minimal stand-in for the Codex browser runtime used by iab-transport tests.
// It records which browser(s) are requested so we can prove brain-command uses the
// in-app browser (iab) exclusively and never falls back to an external browser.
let iabAvailable = false;
let iabThrows = false;
let iabNull = false;
const callLog = [];

function tab() {
  return {
    id: 'mock-tab',
    async goto() {},
    async url() { return 'https://chatgpt.com/c/6a91e45b-77f0-83ea-82bf-32f887010038'; },
    async close() {},
    playwright: {
      async evaluate() {},
      async waitForTimeout() {},
      async waitForLoadState() {},
      async locator() { return { count: async () => 0, first: () => ({ innerText: async () => '', fill: async () => {}, press: async () => {} }) }; },
    },
  };
}

const browsers = {
  async get(name) {
    callLog.push(['get', name]);
    if (name === 'iab') {
      if (iabThrows || !iabAvailable) throw new Error('iab unavailable (mock)');
      if (iabNull) return null;
      return {
        kind: 'iab',
        tabs: { async new() { return tab(); }, async get() { return tab(); }, async list() { return []; }, async selected() { return null; } },
      };
    }
    throw new Error('unknown browser: ' + name);
  },
  async getForUrl(url) {
    callLog.push(['getForUrl', url]);
    return { kind: 'external', url };
  },
};

export function setupBrowserRuntime() { return { browsers }; }

export function __setMockBrowserState({ available = false, throws = false, isNull = false } = {}) {
  iabAvailable = available;
  iabThrows = throws;
  iabNull = isNull;
  callLog.length = 0;
}

export function __getBrowserCallLog() { return callLog.slice(); }
