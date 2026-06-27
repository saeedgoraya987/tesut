import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { consola } from 'consola';
import rateLimit from 'express-rate-limit';
import axios from 'axios';

// Use stealth plugin to bypass Cloudflare
puppeteer.use(StealthPlugin());

// ============ CONFIGURATION ============
const PORT = process.env.PORT || 3000;
const baseUrl = 'https://www.ivasms.com';

// ============ ENVIRONMENT VARIABLES ============
const IVAS_EMAIL = process.env.IVAS_EMAIL || "saeedgoraya982@gmail.com";
const IVAS_PASSWORD = process.env.IVAS_PASSWORD || "77913011";
const TWO_CAPTCHA_API_KEY = process.env.TWO_CAPTCHA_API_KEY || 'd40a0b8b967f22dc7c0cb91a94525d2b';

// Enable trust proxy for Railway
const app = express();
app.set('trust proxy', 1);

// ============ HELPER FUNCTIONS ============
function delay(seconds) {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

// ============ 2CAPTCHA INTEGRATION ============
class TwoCaptchaSolver {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://2captcha.com';
  }

  async solveTurnstile(siteKey, pageUrl) {
    consola.info('Submitting Turnstile challenge to 2captcha...');
    
    try {
      const submitResponse = await axios.post(`${this.baseUrl}/in.php`, null, {
        params: {
          key: this.apiKey,
          method: 'turnstile',
          sitekey: siteKey,
          pageurl: pageUrl,
          json: 1
        }
      });

      if (submitResponse.data.status !== 1) {
        throw new Error(`2captcha error: ${submitResponse.data.request}`);
      }

      const captchaId = submitResponse.data.request;
      consola.info(`Captcha submitted, ID: ${captchaId}`);

      let attempts = 0;
      const maxAttempts = 60;

      while (attempts < maxAttempts) {
        await delay(5);
        
        const resultResponse = await axios.get(`${this.baseUrl}/res.php`, {
          params: {
            key: this.apiKey,
            action: 'get',
            id: captchaId,
            json: 1
          }
        });

        if (resultResponse.data.status === 1) {
          consola.success('Turnstile solved successfully!');
          return resultResponse.data.request;
        }

        if (resultResponse.data.request === 'CAPCHA_NOT_READY') {
          consola.info(`Waiting for solution... (${attempts + 1}/${maxAttempts})`);
          attempts++;
          continue;
        }

        throw new Error(`2captcha error: ${resultResponse.data.request}`);
      }

      throw new Error('Timeout waiting for captcha solution');
    } catch (error) {
      consola.error('2captcha error:', error.message);
      throw error;
    }
  }
}

// ============ BROWSER MANAGEMENT ============
let browser = null;
let isShuttingDown = false;
let authCookies = null;
let authSession = null;
let captchaSolver = null;

async function getBrowser() {
  if (!browser) {
    consola.info('Launching browser with stealth...');
    try {
      const isRailway = !!process.env.RAILWAY_SERVICE_ID || !!process.env.RAILWAY;
      
      browser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--no-first-run',
          '--no-zygote',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-default-apps',
          '--disable-sync',
          '--disable-translate',
          '--hide-scrollbars',
          '--disable-web-security',
          '--disable-features=IsolateOrigins,site-per-process',
          '--disable-blink-features=AutomationControlled',
          '--disable-dev-shm-usage',
          '--disable-ipc-flooding-protection',
          '--disable-renderer-backgrounding',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-breakpad',
          '--disable-component-extensions-with-background-pages',
          '--disable-domain-reliability',
          '--disable-google-remoting',
          '--disable-hang-monitor',
          '--disable-ipc-flooding-protection',
          '--disable-prompt-on-repost',
          '--disable-renderer-backgrounding',
          '--disable-setuid-sandbox',
          '--disable-speech-api',
          '--disable-sync',
          '--disable-wake-on-wifi',
          '--enable-features=NetworkService,NetworkServiceInProcess',
          '--force-color-profile=srgb',
          '--metrics-recording-only',
          '--mute-audio',
          '--no-default-browser-check',
          '--no-pings',
          '--disable-blink-features=AutomationControlled'
        ],
        timeout: 30000,
        ...(isRailway && {
          executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
        })
      });
      
      browser.on('disconnected', () => {
        consola.warn('Browser disconnected');
        browser = null;
        authCookies = null;
        authSession = null;
      });
      
      consola.success('Browser launched successfully with stealth');
      
    } catch (error) {
      consola.error('Failed to launch browser:', error.message);
      throw error;
    }
  }
  return browser;
}

// ============ AUTHENTICATION ============
async function authenticate(page) {
  if (authCookies && authSession) {
    consola.info('Using existing session');
    return true;
  }

  if (!IVAS_EMAIL || !IVAS_PASSWORD) {
    consola.error('Credentials not set');
    throw new Error('Missing credentials.');
  }

  if (!TWO_CAPTCHA_API_KEY || TWO_CAPTCHA_API_KEY === 'YOUR_2CAPTCHA_API_KEY') {
    consola.error('2captcha API key not set');
    throw new Error('Please set TWO_CAPTCHA_API_KEY environment variable');
  }

  consola.info('Authenticating to iVAS...');
  
  try {
    // Initialize captcha solver
    if (!captchaSolver) {
      captchaSolver = new TwoCaptchaSolver(TWO_CAPTCHA_API_KEY);
    }

    // Navigate to login page
    consola.info('Navigating to login page...');
    const response = await page.goto(`${baseUrl}/login`, {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    consola.info(`Response status: ${response ? response.status() : 'No response'}`);
    
    // Wait for page to load
    await delay(3);

    // Check if we're already logged in
    const currentUrl = page.url();
    consola.info(`Current URL: ${currentUrl}`);
    
    if (currentUrl.includes('/portal') || currentUrl.includes('/dashboard')) {
      consola.info('Already logged in!');
      authCookies = await page.cookies();
      authSession = { url: currentUrl, timestamp: Date.now() };
      return true;
    }

    // Wait for the page to fully render
    await page.waitForSelector('form', { timeout: 30000 }).catch(() => {
      consola.warn('Form not found, continuing...');
    });

    // Get CSRF token
    const csrfToken = await page.evaluate(() => {
      const tokenInput = document.querySelector('input[name="_token"]');
      return tokenInput ? tokenInput.value : null;
    });
    consola.info(`CSRF Token: ${csrfToken || 'Not found'}`);

    // Check for Turnstile
    const hasTurnstile = await page.evaluate(() => {
      return !!document.querySelector('.cf-turnstile');
    });
    consola.info(`Turnstile present: ${hasTurnstile}`);

    // Fill credentials
    consola.info('Filling credentials...');
    
    // Email
    const emailField = await page.$('#card-email');
    if (emailField) {
      await emailField.click({ clickCount: 3 });
      await emailField.type(IVAS_EMAIL, { delay: 50 });
      consola.info('Email filled');
    }

    // Password
    const passwordField = await page.$('#card-password');
    if (passwordField) {
      await passwordField.click({ clickCount: 3 });
      await passwordField.type(IVAS_PASSWORD, { delay: 50 });
      consola.info('Password filled');
    }

    // Check "Remember me"
    try {
      await page.click('#card-checkbox');
      consola.info('Checked "Remember me"');
    } catch (e) {
      consola.warn('Could not check "Remember me"');
    }

    // Handle Turnstile if present
    if (hasTurnstile) {
      consola.info('Solving Turnstile...');
      
      const siteKey = '0x4AAAAAACqVmW6ncA-jc10z';
      const pageUrl = page.url();
      const token = await captchaSolver.solveTurnstile(siteKey, pageUrl);
      
      consola.info(`Token received: ${token.substring(0, 20)}...`);

      // Find the Turnstile input and set the token
      const tokenInjected = await page.evaluate((token) => {
        // Try multiple methods to inject the token
        
        // Method 1: Find the Turnstile response input
        let input = document.querySelector('input[name="cf-turnstile-response"]');
        if (input) {
          input.value = token;
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        }

        // Method 2: Try to find the Turnstile widget and call the callback
        const turnstileWidget = document.querySelector('.cf-turnstile');
        if (turnstileWidget) {
          // Try to find the Turnstile iframe and its callback
          const iframes = document.querySelectorAll('iframe');
          for (const iframe of iframes) {
            if (iframe.src && iframe.src.includes('challenges.cloudflare.com')) {
              // Send message to iframe
              try {
                iframe.contentWindow.postMessage({
                  type: 'turnstile-callback',
                  token: token
                }, '*');
              } catch (e) {
                // Ignore cross-origin errors
              }
            }
          }
          
          // Call the global turnstile callback if available
          if (window.turnstile && typeof window.turnstile.render === 'function') {
            try {
              // Find the widget ID
              const widgetId = turnstileWidget.getAttribute('data-widget-id');
              if (widgetId) {
                window.turnstile.render(widgetId, { callback: function(t) {} });
              }
            } catch (e) {}
          }
          
          return true;
        }

        // Method 3: Find any input with turnstile in the name
        const allInputs = document.querySelectorAll('input');
        for (const inp of allInputs) {
          if (inp.name && inp.name.toLowerCase().includes('turnstile')) {
            inp.value = token;
            inp.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        }

        return false;
      }, token);

      consola.info(`Token injection result: ${tokenInjected}`);

      // Wait a moment for Turnstile to process
      await delay(3);

      // Verify the token was set
      const tokenSet = await page.evaluate(() => {
        const input = document.querySelector('input[name="cf-turnstile-response"]');
        return input ? input.value && input.value.length > 0 : false;
      });

      consola.info(`Token set in form: ${tokenSet}`);
    }

    // Submit the form
    consola.info('Submitting login form...');
    
    // Try multiple submit methods
    let submitted = false;
    
    // Method 1: Click submit button
    const submitBtn = await page.$('button[type="submit"]');
    if (submitBtn) {
      await submitBtn.click();
      submitted = true;
      consola.info('Clicked submit button');
    }
    
    // Method 2: JavaScript submit
    if (!submitted) {
      await page.evaluate(() => {
        const form = document.querySelector('form');
        if (form) {
          form.submit();
        }
      });
      consola.info('Used JavaScript form submit');
    }

    // Wait for navigation
    consola.info('Waiting for navigation...');
    await page.waitForNavigation({
      waitUntil: 'networkidle2',
      timeout: 30000
    }).catch((e) => {
      consola.warn('Navigation timeout:', e.message);
    });

    const finalUrl = page.url();
    consola.info(`Final URL: ${finalUrl}`);

    if (finalUrl.includes('/portal') || finalUrl.includes('/dashboard')) {
      consola.success('Authentication successful!');
      authCookies = await page.cookies();
      authSession = { url: finalUrl, timestamp: Date.now() };
      return true;
    }

    // Check for error message
    const errorMessage = await page.evaluate(() => {
      const selectors = ['.alert-danger', '.alert-error', '.invalid-feedback', '.text-danger'];
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (el) return el.textContent?.trim();
      }
      return null;
    });

    if (errorMessage) {
      consola.error('Login failed:', errorMessage);
    } else {
      consola.error('Login failed: Unknown error');
    }

    return false;
  } catch (error) {
    consola.error('Authentication error:', error.message);
    return false;
  }
}

// ============ PORTAL DATA ============
async function getPortalData(page) {
  const authSuccess = await authenticate(page);
  if (!authSuccess) throw new Error('Authentication failed');
  
  consola.info('Fetching portal data...');
  await page.goto(`${baseUrl}/portal`, {
    waitUntil: 'networkidle2',
    timeout: 30000
  });

  const portalData = await page.evaluate(() => {
    const result = {
      user: { name: '', email: '', level: '' },
      stats: { revenue: '', cdr: '', lastWeekRevenue: '', lastWeekCdr: '' },
      topApplications: [],
      topRanges: [],
      liveTestSMS: [],
      accountCode: ''
    };

    const userPanel = document.querySelector('.user-panel .info a');
    if (userPanel) result.user.name = userPanel.textContent?.trim() || '';

    const accountCodeEl = document.querySelector('.account-code span');
    if (accountCodeEl) result.accountCode = accountCodeEl.textContent?.trim() || '';

    const revenueLabel = document.querySelector('#RevenueLabel');
    if (revenueLabel) result.stats.revenue = revenueLabel.textContent?.trim() || '';

    const cdrLabel = document.querySelector('#CdrLabel');
    if (cdrLabel) result.stats.cdr = cdrLabel.textContent?.trim() || '';

    document.querySelectorAll('.social-grid-table tbody tr').forEach(row => {
      row.querySelectorAll('td').forEach(cell => {
        const nameEl = cell.querySelector('p');
        const countEl = cell.querySelector('small');
        if (nameEl && countEl) {
          result.topApplications.push({
            name: nameEl.textContent?.trim() || '',
            count: countEl.textContent?.trim() || '',
            icon: cell.querySelector('i')?.className || ''
          });
        }
      });
    });

    document.querySelectorAll('#LiveTestSMS tr').forEach(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length >= 3) {
        const nameEl = cells[0]?.querySelector('h6 a');
        const numberEl = cells[0]?.querySelector('p');
        const messageEl = cells[2];
        result.liveTestSMS.push({
          name: nameEl?.textContent?.trim() || '',
          number: numberEl?.textContent?.trim() || '',
          message: messageEl?.textContent?.trim() || ''
        });
      }
    });

    return result;
  });

  return portalData;
}

// ============ NUMBERS ============
async function getNumbers(page) {
  const authSuccess = await authenticate(page);
  if (!authSuccess) throw new Error('Authentication failed');
  
  await page.goto(`${baseUrl}/portal/numbers`, {
    waitUntil: 'networkidle2',
    timeout: 30000
  });

  return await page.evaluate(() => {
    const results = [];
    document.querySelectorAll('.table tbody tr').forEach(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length >= 2) {
        const numberEl = cells[0]?.querySelector('.fw-semi-bold, .number');
        const statusEl = cells[1]?.querySelector('.badge, .status');
        if (numberEl) {
          results.push({
            number: numberEl.textContent?.trim() || '',
            status: statusEl?.textContent?.trim() || 'Unknown'
          });
        }
      }
    });
    return results;
  });
}

// ============ MESSAGES ============
async function getMessages(page, number) {
  const authSuccess = await authenticate(page);
  if (!authSuccess) throw new Error('Authentication failed');
  
  await page.goto(`${baseUrl}/portal/sms/test/sms`, {
    waitUntil: 'networkidle2',
    timeout: 30000
  });

  return await page.evaluate((searchNumber) => {
    const results = [];
    document.querySelectorAll('.table tbody tr').forEach(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length >= 3) {
        const numberEl = cells[0]?.querySelector('.number, .fw-semi-bold');
        const messageEl = cells[1];
        const timeEl = cells[2];
        const numberText = numberEl?.textContent?.trim() || '';
        const message = messageEl?.textContent?.trim() || '';
        
        if ((!searchNumber || numberText.includes(searchNumber)) && message) {
          const otpMatch = message.match(/\b\d{4,6}\b/);
          results.push({
            number: numberText,
            message: message,
            time: timeEl?.textContent?.trim() || 'now',
            otp: otpMatch ? otpMatch[0] : undefined
          });
        }
      }
    });
    return results;
  }, number);
}

// ============ CHECK STATUS ============
async function checkLoginStatus() {
  if (!authCookies) return false;
  
  try {
    const browserInstance = await getBrowser();
    const page = await browserInstance.newPage();
    await page.setCookie(...authCookies);
    await page.goto(`${baseUrl}/portal`, {
      waitUntil: 'networkidle2',
      timeout: 10000
    });
    return page.url().includes('/portal');
  } catch (error) {
    return false;
  }
}

// ============ EXPRESS APP ============

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  skip: (req) => req.path === '/health',
  standardHeaders: true,
  legacyHeaders: false,
  trustProxy: false
});

app.use(cors());
app.use(express.json());
app.use('/api/', limiter);

// ============ HEALTH CHECK ============
app.get('/health', async (req, res) => {
  const isAuthenticated = await checkLoginStatus();
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'ivas-sms-monitor',
    authenticated: isAuthenticated,
    environment: process.env.RAILWAY ? 'railway' : 'local',
    email: IVAS_EMAIL ? 'Set' : 'Not set',
    captcha_key: TWO_CAPTCHA_API_KEY ? 'Set' : 'Not set'
  });
});

// ============ API ENDPOINTS ============

app.get('/api/portal', async (req, res) => {
  try {
    const browserInstance = await getBrowser();
    const page = await browserInstance.newPage();
    const data = await getPortalData(page);
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/numbers', async (req, res) => {
  try {
    const browserInstance = await getBrowser();
    const page = await browserInstance.newPage();
    const numbers = await getNumbers(page);
    res.json({ success: true, numbers });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/messages/:number', async (req, res) => {
  try {
    const { number } = req.params;
    const browserInstance = await getBrowser();
    const page = await browserInstance.newPage();
    const messages = await getMessages(page, number);
    res.json({ success: true, number, messages });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const browserInstance = await getBrowser();
    const page = await browserInstance.newPage();
    const success = await authenticate(page);
    
    if (success) {
      res.json({ success: true, message: 'Login successful' });
    } else {
      res.status(401).json({ success: false, error: 'Login failed' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/logout', async (req, res) => {
  authCookies = null;
  authSession = null;
  res.json({ success: true, message: 'Logged out' });
});

app.get('/api/status', async (req, res) => {
  const isAuthenticated = await checkLoginStatus();
  res.json({ authenticated: isAuthenticated, sessionActive: !!authSession });
});

app.post('/api/cleanup', async (req, res) => {
  if (browser) {
    await browser.close();
    browser = null;
    authCookies = null;
    authSession = null;
  }
  res.json({ success: true });
});

// ============ START SERVER ============
const server = app.listen(PORT, '0.0.0.0', () => {
  consola.success(`🚀 Server running on port ${PORT}`);
  consola.info(`📍 Health check: http://localhost:${PORT}/health`);
  consola.info(`📱 API endpoints available at /api/`);
  consola.info(`📧 Email: ${IVAS_EMAIL ? 'Set' : 'NOT SET'}`);
  consola.info(`🔑 Password: ${IVAS_PASSWORD ? 'Set' : 'NOT SET'}`);
  consola.info(`🔐 2captcha Key: ${TWO_CAPTCHA_API_KEY && TWO_CAPTCHA_API_KEY !== 'YOUR_2CAPTCHA_API_KEY' ? 'Set' : 'NOT SET'}`);
});

// ============ GRACEFUL SHUTDOWN ============
async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  consola.info(`${signal} received, closing...`);
  server.close(() => consola.info('Server closed'));
  if (browser) {
    await browser.close();
    consola.info('Browser closed');
  }
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

export default app;
