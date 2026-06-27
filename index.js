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
app.set('trust proxy', true);

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
      // Submit captcha to 2captcha
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

      // Wait for solution
      let attempts = 0;
      const maxAttempts = 60; // 60 * 5 seconds = 5 minutes max

      while (attempts < maxAttempts) {
        await delay(5); // Wait 5 seconds between checks
        
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

  async solveCloudflare(page) {
    consola.info('Detecting Cloudflare challenge...');
    
    try {
      // Check if it's a Cloudflare challenge
      const isCloudflare = await page.evaluate(() => {
        const title = document.title;
        return title.includes('Just a moment') || 
               title.includes('Cloudflare') || 
               title.includes('Attention Required');
      });

      if (!isCloudflare) {
        consola.info('No Cloudflare challenge detected');
        return true;
      }

      consola.info('Cloudflare challenge detected, solving with 2captcha...');
      
      // Get the site key
      const siteKey = await page.evaluate(() => {
        // Look for Turnstile site key
        const turnstileElement = document.querySelector('.cf-turnstile');
        if (turnstileElement) {
          return turnstileElement.getAttribute('data-sitekey');
        }
        
        // Look for it in script tags
        const scripts = document.querySelectorAll('script');
        for (const script of scripts) {
          const content = script.textContent || '';
          const match = content.match(/sitekey:\s*['"]([^'"]+)['"]/);
          if (match) return match[1];
        }
        
        // Common site keys
        const commonKeys = [
          '0x4AAAAAACqVmW6ncA-jc10z',
          '0x4AAAAAACqVmW6ncA-jc10z'
        ];
        return commonKeys[0];
      });

      consola.info(`Found site key: ${siteKey}`);

      // Solve with 2captcha
      const pageUrl = page.url();
      const token = await this.solveTurnstile(siteKey, pageUrl);

      // Inject the token
      await page.evaluate((token) => {
        // Try to find Turnstile input
        const turnstileInput = document.querySelector('input[name="cf-turnstile-response"]');
        if (turnstileInput) {
          turnstileInput.value = token;
          // Trigger change event
          turnstileInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, token);

      consola.info('Token injected, waiting for verification...');
      await delay(3);

      // Try to submit the form if it's a login page
      const isLoginPage = page.url().includes('/login');
      if (isLoginPage) {
        await page.evaluate(() => {
          const form = document.querySelector('form');
          if (form) form.submit();
        });
        await delay(3);
      } else {
        // For Cloudflare challenge page, click the submit or refresh
        await page.evaluate(() => {
          const submitBtn = document.querySelector('button[type="submit"], .challenge-submit, #challenge-form input[type="submit"]');
          if (submitBtn) submitBtn.click();
        });
        await delay(3);
      }

      // Check if solved
      const solved = await page.evaluate(() => {
        const title = document.title;
        return !title.includes('Just a moment') && 
               !title.includes('Cloudflare') && 
               !title.includes('Attention Required');
      });

      if (solved) {
        consola.success('Cloudflare challenge solved successfully!');
        return true;
      }

      // If not solved, try refreshing
      consola.info('Challenge not solved, refreshing...');
      await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
      await delay(3);

      return true;
    } catch (error) {
      consola.error('Error solving Cloudflare:', error.message);
      return false;
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

// ============ AUTHENTICATION WITH 2CAPTCHA ============
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

  // Initialize captcha solver
  if (!captchaSolver) {
    captchaSolver = new TwoCaptchaSolver(TWO_CAPTCHA_API_KEY);
  }

  consola.info('Authenticating to iVAS...');
  
  try {
    // Navigate to login page
    consola.info('Navigating to login page...');
    await page.goto(`${baseUrl}/login`, {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    await delay(3);

    // Check for Cloudflare challenge
    const title = await page.title();
    consola.info(`Page title: ${title}`);
    
    if (title.includes('Just a moment') || title.includes('Cloudflare')) {
      consola.info('Cloudflare detected, solving with 2captcha...');
      const solved = await captchaSolver.solveCloudflare(page);
      if (!solved) {
        throw new Error('Failed to solve Cloudflare challenge');
      }
      await delay(3);
    }

    // Check current URL after Cloudflare
    const currentUrl = page.url();
    consola.info(`Current URL: ${currentUrl}`);
    
    if (currentUrl.includes('/portal') || currentUrl.includes('/dashboard')) {
      consola.info('Already logged in!');
      authCookies = await page.cookies();
      authSession = { url: currentUrl, timestamp: Date.now() };
      return true;
    }

    // Wait for login form
    await page.waitForSelector('form, #card-email', { 
      timeout: 30000,
      visible: true 
    }).catch(() => {
      consola.warn('Login form not found');
    });

    // Fill credentials
    consola.info('Filling credentials...');
    
    // Email
    const emailField = await page.$('#card-email') || await page.$('input[name="email"]');
    if (emailField) {
      await emailField.click({ clickCount: 3 });
      await emailField.type(IVAS_EMAIL, { delay: 50 });
      consola.info('Email filled');
    }

    // Password
    const passwordField = await page.$('#card-password') || await page.$('input[name="password"]');
    if (passwordField) {
      await passwordField.click({ clickCount: 3 });
      await passwordField.type(IVAS_PASSWORD, { delay: 50 });
      consola.info('Password filled');
    }

    // Check for Turnstile on login form
    const hasTurnstile = await page.evaluate(() => {
      return !!document.querySelector('.cf-turnstile');
    });

    if (hasTurnstile) {
      consola.info('Turnstile detected on login form, solving...');
      
      // Get site key
      const siteKey = await page.evaluate(() => {
        const el = document.querySelector('.cf-turnstile');
        return el ? el.getAttribute('data-sitekey') : '0x4AAAAAACqVmW6ncA-jc10z';
      });
      
      const pageUrl = page.url();
      const token = await captchaSolver.solveTurnstile(siteKey, pageUrl);
      
      // Inject token
      await page.evaluate((token) => {
        const input = document.querySelector('input[name="cf-turnstile-response"]');
        if (input) {
          input.value = token;
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, token);
      
      consola.info('Turnstile token injected');
      await delay(2);
    }

    // Submit form
    consola.info('Submitting form...');
    const submitBtn = await page.$('button[type="submit"]');
    if (submitBtn) {
      await submitBtn.click();
    } else {
      await page.evaluate(() => {
        const form = document.querySelector('form');
        if (form) form.submit();
      });
    }

    // Wait for navigation
    await page.waitForNavigation({
      waitUntil: 'networkidle2',
      timeout: 30000
    }).catch(() => consola.warn('Navigation timeout'));

    const finalUrl = page.url();
    consola.info(`Final URL: ${finalUrl}`);

    if (finalUrl.includes('/portal') || finalUrl.includes('/dashboard')) {
      consola.success('Authentication successful!');
      authCookies = await page.cookies();
      authSession = { url: finalUrl, timestamp: Date.now() };
      return true;
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
  legacyHeaders: false
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
