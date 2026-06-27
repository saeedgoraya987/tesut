import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { consola } from 'consola';
import rateLimit from 'express-rate-limit';
import axios from 'axios';
import fs from 'fs';

// Use stealth plugin to bypass Cloudflare
puppeteer.use(StealthPlugin());

// ============ CONFIGURATION ============
const PORT = process.env.PORT || 3000;
const baseUrl = 'https://www.ivasms.com';

// ============ ENVIRONMENT VARIABLES ============
const IVAS_EMAIL = process.env.IVAS_EMAIL || "saeedgoraya982@gmail.com";
const IVAS_PASSWORD = process.env.IVAS_PASSWORD || "77913011";
const TWO_CAPTCHA_API_KEY = process.env.TWO_CAPTCHA_API_KEY || 'YOUR_2CAPTCHA_API_KEY';

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

// ============ CLOUDFLARE WAIT FUNCTION ============
async function waitForCloudflareToFinish(page, timeout = 60000) {
  consola.info('Waiting for Cloudflare challenge to resolve...');
  
  const startTime = Date.now();
  let attempts = 0;
  
  while (Date.now() - startTime < timeout) {
    attempts++;
    const title = await page.title().catch(() => '');
    const url = page.url();
    
    // Check if we've been redirected to the actual login page
    if (url.includes('/login') && !title.includes('Just a moment') && !title.includes('Cloudflare')) {
      consola.success('Cloudflare challenge resolved!');
      return true;
    }
    
    // Check if we're already past Cloudflare
    if (url.includes('/portal') || url.includes('/dashboard')) {
      consola.success('Already past Cloudflare!');
      return true;
    }
    
    // Check if the page has the actual login form
    const hasForm = await page.evaluate(() => {
      return !!document.querySelector('form');
    }).catch(() => false);
    
    if (hasForm && !title.includes('Just a moment')) {
      consola.success('Login form detected!');
      return true;
    }
    
    // Wait and try again
    consola.info(`Still waiting for Cloudflare... (${attempts}s)`);
    await delay(3); // Wait 3 seconds between checks
  }
  
  consola.error('Cloudflare challenge timed out');
  return false;
}

// ============ DEBUG FUNCTION ============
async function debugPage(page, url) {
  consola.info('========== DEBUG START ==========');
  consola.info(`Target URL: ${url}`);
  
  try {
    // Navigate with detailed options
    const response = await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    consola.info(`Response status: ${response ? response.status() : 'No response'}`);
    consola.info(`Response headers: ${JSON.stringify(response ? response.headers() : {}, null, 2)}`);

    // Wait a moment for any JavaScript to execute
    await delay(3);

    // Get page information
    const pageInfo = await page.evaluate(() => {
      return {
        title: document.title,
        url: window.location.href,
        bodyText: document.body.innerText.substring(0, 2000),
        bodyHTML: document.documentElement.outerHTML.substring(0, 5000),
        hasCloudflare: document.body.innerText.includes('Cloudflare') || 
                       document.body.innerText.includes('Just a moment') ||
                       document.body.innerText.includes('Attention Required'),
        forms: Array.from(document.querySelectorAll('form')).map(form => ({
          action: form.action,
          method: form.method,
          inputs: Array.from(form.querySelectorAll('input')).map(input => ({
            name: input.name,
            type: input.type,
            id: input.id
          }))
        })),
        turnstile: !!document.querySelector('.cf-turnstile'),
        hcaptcha: !!document.querySelector('.h-captcha'),
        recaptcha: !!document.querySelector('.g-recaptcha'),
        metaTags: Array.from(document.querySelectorAll('meta')).map(meta => ({
          name: meta.name,
          content: meta.content
        })),
        scripts: Array.from(document.querySelectorAll('script')).map(script => ({
          src: script.src,
          type: script.type
        })).slice(0, 10),
        cookies: document.cookie
      };
    });

    // Log page info
    consola.info(`Page Title: ${pageInfo.title}`);
    consola.info(`Page URL: ${pageInfo.url}`);
    consola.info(`Has Cloudflare: ${pageInfo.hasCloudflare}`);
    consola.info(`Has Turnstile: ${pageInfo.turnstile}`);
    consola.info(`Has hCaptcha: ${pageInfo.hcaptcha}`);
    consola.info(`Has reCAPTCHA: ${pageInfo.recaptcha}`);
    consola.info(`Number of forms: ${pageInfo.forms.length}`);
    consola.info(`Cookies: ${pageInfo.cookies}`);

    // Log form details
    if (pageInfo.forms.length > 0) {
      pageInfo.forms.forEach((form, index) => {
        consola.info(`Form ${index + 1}: action=${form.action}, method=${form.method}`);
        form.inputs.forEach(input => {
          consola.info(`  Input: name=${input.name}, type=${input.type}, id=${input.id}`);
        });
      });
    }

    // Take screenshot
    const screenshotPath = '/tmp/debug-screenshot.png';
    await page.screenshot({ path: screenshotPath, fullPage: true });
    consola.info(`Screenshot saved to: ${screenshotPath}`);

    // Save HTML content to file
    const htmlPath = '/tmp/debug-page.html';
    fs.writeFileSync(htmlPath, pageInfo.bodyHTML);
    consola.info(`HTML saved to: ${htmlPath}`);

    // Check for Cloudflare challenge
    if (pageInfo.hasCloudflare) {
      consola.warn('Cloudflare challenge detected!');
      
      // Try to find the challenge iframe
      const iframeInfo = await page.evaluate(() => {
        const iframes = document.querySelectorAll('iframe');
        return Array.from(iframes).map(iframe => ({
          src: iframe.src,
          id: iframe.id,
          className: iframe.className
        }));
      });
      
      consola.info(`Iframes found: ${JSON.stringify(iframeInfo, null, 2)}`);

      // Look for Turnstile site key
      const siteKey = await page.evaluate(() => {
        // Check for Turnstile
        const turnstile = document.querySelector('.cf-turnstile');
        if (turnstile) {
          return turnstile.getAttribute('data-sitekey');
        }
        
        // Check in script tags
        const scripts = document.querySelectorAll('script');
        for (const script of scripts) {
          const content = script.textContent || '';
          const match = content.match(/sitekey\s*[:=]\s*['"]([^'"]+)['"]/);
          if (match) return match[1];
        }
        
        return null;
      });
      
      consola.info(`Turnstile Site Key: ${siteKey || 'Not found'}`);
    }

    consola.info('========== DEBUG END ==========');
    
    return pageInfo;
  } catch (error) {
    consola.error('Debug error:', error.message);
    
    // Try to get whatever we can
    try {
      const content = await page.content();
      consola.info('Page content (partial):', content.substring(0, 1000));
    } catch (e) {
      consola.error('Could not get page content');
    }
    
    throw error;
  }
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

  consola.info('Authenticating to iVAS...');
  
  try {
    // Initialize captcha solver
    if (!captchaSolver) {
      captchaSolver = new TwoCaptchaSolver(TWO_CAPTCHA_API_KEY);
    }

    // Navigate to login page
    consola.info('Navigating to login page...');
    await page.goto(`${baseUrl}/login`, {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    // Wait for Cloudflare challenge to resolve
    consola.info('Checking for Cloudflare challenge...');
    const cfResolved = await waitForCloudflareToFinish(page);
    
    if (!cfResolved) {
      consola.warn('Cloudflare challenge did not resolve automatically, trying reload...');
      await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
      await delay(5);
      
      // Check again after reload
      const title = await page.title();
      if (title.includes('Just a moment') || title.includes('Cloudflare')) {
        consola.error('Cloudflare still blocking after reload');
        return false;
      }
    }

    // Check if we're already logged in
    const currentUrl = page.url();
    consola.info(`Current URL after Cloudflare: ${currentUrl}`);
    
    if (currentUrl.includes('/portal') || currentUrl.includes('/dashboard')) {
      consola.info('Already logged in!');
      authCookies = await page.cookies();
      authSession = { url: currentUrl, timestamp: Date.now() };
      return true;
    }

    // Wait for the login form to appear
    consola.info('Waiting for login form...');
    await page.waitForSelector('form, #card-email', { 
      timeout: 30000,
      visible: true 
    }).catch(() => {
      consola.warn('Login form not found, checking page content...');
    });

    // Check if form exists
    const formExists = await page.evaluate(() => {
      return !!document.querySelector('form');
    });
    
    if (!formExists) {
      // Try to get the page content for debugging
      const bodyText = await page.evaluate(() => document.body.innerText);
      consola.error('Page content:', bodyText.substring(0, 500));
      consola.error('Login form not found - Cloudflare may still be blocking');
      return false;
    }

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
    } else {
      consola.warn('Email field not found');
    }

    // Password
    const passwordField = await page.$('#card-password');
    if (passwordField) {
      await passwordField.click({ clickCount: 3 });
      await passwordField.type(IVAS_PASSWORD, { delay: 50 });
      consola.info('Password filled');
    } else {
      consola.warn('Password field not found');
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

      // Inject the token
      const tokenInjected = await page.evaluate((token) => {
        const input = document.querySelector('input[name="cf-turnstile-response"]');
        if (input) {
          input.value = token;
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        }
        return false;
      }, token);

      consola.info(`Token injection result: ${tokenInjected}`);
      await delay(3);
    }

    // Submit the form
    consola.info('Submitting login form...');
    
    let submitted = false;
    
    const submitBtn = await page.$('button[type="submit"]');
    if (submitBtn) {
      await submitBtn.click();
      submitted = true;
      consola.info('Clicked submit button');
    }
    
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

    const lastWeekRevenue = document.querySelector('#LastWeekRevenueLabel');
    if (lastWeekRevenue) result.stats.lastWeekRevenue = lastWeekRevenue.textContent?.trim() || '';

    const lastWeekCdr = document.querySelector('#LastWeekCdrLabel');
    if (lastWeekCdr) result.stats.lastWeekCdr = lastWeekCdr.textContent?.trim() || '';

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
  skip: (req) => req.path === '/health' || req.path === '/debug',
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
    captcha_key: TWO_CAPTCHA_API_KEY && TWO_CAPTCHA_API_KEY !== 'YOUR_2CAPTCHA_API_KEY' ? 'Set' : 'Not set'
  });
});

// ============ DEBUG ENDPOINT ============
app.get('/api/debug', async (req, res) => {
  try {
    const url = req.query.url || 'https://www.ivasms.com/login';
    consola.info(`Debug endpoint called for URL: ${url}`);
    
    const browserInstance = await getBrowser();
    const page = await browserInstance.newPage();
    
    try {
      const debugInfo = await debugPage(page, url);
      
      res.json({
        success: true,
        url: url,
        debug: debugInfo,
        timestamp: new Date().toISOString()
      });
    } finally {
      await page.close().catch(() => {});
    }
  } catch (error) {
    consola.error('Debug error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack
    });
  }
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

app.get('/api/live-sms', async (req, res) => {
  try {
    const browserInstance = await getBrowser();
    const page = await browserInstance.newPage();
    const data = await getPortalData(page);
    res.json({ success: true, liveSms: data.liveTestSMS || [] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/top-apps', async (req, res) => {
  try {
    const browserInstance = await getBrowser();
    const page = await browserInstance.newPage();
    const data = await getPortalData(page);
    res.json({ success: true, topApplications: data.topApplications || [] });
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
  res.json({ 
    authenticated: isAuthenticated, 
    sessionActive: !!authSession,
    email: IVAS_EMAIL ? 'Set' : 'Not set'
  });
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
  consola.info(`🔍 Debug endpoint: http://localhost:${PORT}/api/debug?url=https://www.ivasms.com/login`);
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
