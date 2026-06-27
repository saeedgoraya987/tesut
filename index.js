import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { consola } from 'consola';
import rateLimit from 'express-rate-limit';

// Use stealth plugin to bypass Cloudflare
puppeteer.use(StealthPlugin());

// ============ CONFIGURATION ============
const PORT = process.env.PORT || 3000;
const baseUrl = 'https://www.ivasms.com';
const defaultRecheckDelay = 5; // seconds

// ============ ENVIRONMENT VARIABLES ============
const IVAS_EMAIL = "saeedgoraya982@gmail.com";
const IVAS_PASSWORD = "77913011";

// Enable trust proxy for Railway
const app = express();
app.set('trust proxy', true);

// ============ HELPER FUNCTIONS ============
function tryParseOtpCode(message) {
  if (!message) return undefined;
  const otpMatch = message.match(/\b\d{4,6}\b/);
  return otpMatch ? otpMatch[0] : undefined;
}

function parseTimeAgo(agoText) {
  if (!agoText) return 0;
  const match = agoText.match(/(\d+)\s*(min|sec|hour|day)/i);
  if (!match) return 0;
  
  const value = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  const now = Date.now();
  
  if (unit.includes('min')) return now - value * 60 * 1000;
  if (unit.includes('sec')) return now - value * 1000;
  if (unit.includes('hour')) return now - value * 3600 * 1000;
  if (unit.includes('day')) return now - value * 86400 * 1000;
  
  return 0;
}

function delay(seconds) {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

// ============ BROWSER MANAGEMENT ============
let browser = null;
let isShuttingDown = false;
let authCookies = null;
let authSession = null;

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
          '--no-pings'
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

// ============ AUTHENTICATION WITH BETTER LOADING ============
async function authenticate(page) {
  if (authCookies && authSession) {
    consola.info('Using existing session');
    return true;
  }

  if (!IVAS_EMAIL || !IVAS_PASSWORD) {
    consola.error('IVAS_EMAIL and IVAS_PASSWORD environment variables must be set');
    throw new Error('Missing credentials.');
  }

  consola.info('Authenticating to iVAS...');
  
  try {
    // Navigate to login page with more wait options
    consola.info('Navigating to login page...');
    const response = await page.goto(`${baseUrl}/login`, {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    // Check response status
    consola.info(`Response status: ${response ? response.status() : 'No response'}`);

    // Wait for page to fully load
    await page.waitForFunction(
      () => document.readyState === 'complete',
      { timeout: 30000 }
    ).catch(() => consola.warn('Page did not fully load'));

    await delay(3);

    // Check if we're already logged in (redirected to portal)
    const currentUrl = page.url();
    consola.info(`Current URL: ${currentUrl}`);
    
    if (currentUrl.includes('/portal') || currentUrl.includes('/dashboard')) {
      consola.info('Already logged in!');
      authCookies = await page.cookies();
      authSession = {
        url: currentUrl,
        timestamp: Date.now()
      };
      return true;
    }

    // Take screenshot for debugging
    await page.screenshot({ path: 'login-page.png' }).catch(() => {
      consola.warn('Could not take screenshot');
    });

    // Get page content to debug
    const pageTitle = await page.title();
    consola.info(`Page title: ${pageTitle}`);

    // Check for Cloudflare challenge
    const hasCloudflare = await page.evaluate(() => {
      return document.body.innerText.includes('Cloudflare') || 
             document.body.innerText.includes('Just a moment') ||
             document.body.innerText.includes('Attention Required');
    });

    if (hasCloudflare) {
      consola.warn('Cloudflare challenge detected, waiting...');
      await delay(10);
    }

    // Wait for the login form to be visible
    consola.info('Waiting for login form...');
    await page.waitForSelector('form, #card-email, input[name="email"]', { 
      timeout: 30000,
      visible: true 
    }).catch(() => {
      consola.warn('Login form not found, checking page content...');
    });

    // Check if form exists
    const formExists = await page.evaluate(() => {
      return !!document.querySelector('form');
    });
    consola.info(`Form exists: ${formExists}`);

    if (!formExists) {
      // Log the page content for debugging
      const bodyText = await page.evaluate(() => document.body.innerText);
      consola.error('Page content:', bodyText.substring(0, 500));
      throw new Error('Login form not found on page');
    }

    // Get CSRF token
    const token = await page.evaluate(() => {
      const tokenInput = document.querySelector('input[name="_token"]');
      return tokenInput ? tokenInput.value : null;
    });
    consola.info(`CSRF Token: ${token || 'Not found'}`);

    // Fill in login form - try multiple selectors
    consola.info('Filling login form...');
    
    // Email field
    const emailField = await page.$('#card-email') || await page.$('input[name="email"]');
    if (emailField) {
      await emailField.click({ clickCount: 3 });
      await emailField.type(IVAS_EMAIL, { delay: 100 });
      consola.info('Email filled');
    } else {
      consola.warn('Email field not found');
    }

    // Password field
    const passwordField = await page.$('#card-password') || await page.$('input[name="password"]');
    if (passwordField) {
      await passwordField.click({ clickCount: 3 });
      await passwordField.type(IVAS_PASSWORD, { delay: 100 });
      consola.info('Password filled');
    } else {
      consola.warn('Password field not found');
    }

    // Check "Remember me" if available
    try {
      const rememberCheckbox = await page.$('#card-checkbox');
      if (rememberCheckbox) {
        await rememberCheckbox.click();
        consola.info('Checked "Remember me"');
      }
    } catch (e) {
      consola.warn('Could not check "Remember me"');
    }

    // Handle Cloudflare Turnstile
    consola.info('Handling Cloudflare Turnstile...');
    
    // Check for Turnstile
    const hasTurnstile = await page.evaluate(() => {
      return !!document.querySelector('.cf-turnstile');
    });
    consola.info(`Turnstile present: ${hasTurnstile}`);

    if (hasTurnstile) {
      consola.info('Waiting for Turnstile to auto-solve...');
      await delay(10); // Give Turnstile more time
    }

    // Submit the form
    consola.info('Submitting login form...');
    
    let submitted = false;
    
    // Method 1: Click submit button
    const submitBtn = await page.$('button[type="submit"]');
    if (submitBtn) {
      await submitBtn.click();
      submitted = true;
      consola.info('Clicked submit button');
    }
    
    // Method 2: Try form submit if button didn't work
    if (!submitted) {
      await page.evaluate(() => {
        const form = document.querySelector('form');
        if (form) form.submit();
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

    // Check result
    const finalUrl = page.url();
    consola.info(`Final URL after login: ${finalUrl}`);
    
    // Take screenshot after login attempt
    await page.screenshot({ path: 'login-result.png' }).catch(() => {});

    if (finalUrl.includes('/portal') || finalUrl.includes('/dashboard')) {
      consola.success('Authentication successful!');
      
      authCookies = await page.cookies();
      authSession = {
        url: finalUrl,
        timestamp: Date.now()
      };
      
      return true;
    } else {
      // Check for error message
      const errorMessage = await page.evaluate(() => {
        const selectors = [
          '.alert-danger', 
          '.alert-error', 
          '.invalid-feedback', 
          '.text-danger',
          '.alert',
          '.error-message'
        ];
        for (const selector of selectors) {
          const el = document.querySelector(selector);
          if (el) return el.textContent?.trim();
        }
        return null;
      });
      
      if (errorMessage) {
        consola.error('Authentication failed:', errorMessage);
      } else {
        consola.error('Authentication failed: Unknown error');
      }
      
      return false;
    }
  } catch (error) {
    consola.error('Authentication error:', error.message);
    return false;
  }
}

// ============ PORTAL / DASHBOARD ============
async function getPortalData(page) {
  const authSuccess = await authenticate(page);
  if (!authSuccess) {
    throw new Error('Authentication failed');
  }
  
  consola.info('Fetching portal data...');
  await page.goto(`${baseUrl}/portal`, {
    waitUntil: 'networkidle2',
    timeout: 30000
  });

  const portalData = await page.evaluate(() => {
    const result = {
      user: {
        name: '',
        email: '',
        level: ''
      },
      stats: {
        revenue: '',
        cdr: '',
        lastWeekRevenue: '',
        lastWeekCdr: ''
      },
      topApplications: [],
      topRanges: [],
      liveTestSMS: [],
      accountCode: ''
    };

    // Get user info
    const userPanel = document.querySelector('.user-panel .info a');
    if (userPanel) {
      result.user.name = userPanel.textContent?.trim() || '';
    }
    
    const emailEl = document.querySelector('.user-panel .info a[style*="font-size: 10px"]');
    if (emailEl) {
      result.user.email = emailEl.textContent?.trim() || '';
    }

    // Get account code
    const accountCodeEl = document.querySelector('.account-code span');
    if (accountCodeEl) {
      result.accountCode = accountCodeEl.textContent?.trim() || '';
    }

    // Get revenue stats
    const revenueLabel = document.querySelector('#RevenueLabel');
    if (revenueLabel) {
      result.stats.revenue = revenueLabel.textContent?.trim() || '';
    }

    const cdrLabel = document.querySelector('#CdrLabel');
    if (cdrLabel) {
      result.stats.cdr = cdrLabel.textContent?.trim() || '';
    }

    const lastWeekRevenue = document.querySelector('#LastWeekRevenueLabel');
    if (lastWeekRevenue) {
      result.stats.lastWeekRevenue = lastWeekRevenue.textContent?.trim() || '';
    }

    const lastWeekCdr = document.querySelector('#LastWeekCdrLabel');
    if (lastWeekCdr) {
      result.stats.lastWeekCdr = lastWeekCdr.textContent?.trim() || '';
    }

    // Get top applications
    const appRows = document.querySelectorAll('.social-grid-table tbody tr');
    appRows.forEach(row => {
      const cells = row.querySelectorAll('td');
      cells.forEach(cell => {
        const icon = cell.querySelector('i');
        const nameEl = cell.querySelector('p');
        const countEl = cell.querySelector('small');
        
        if (nameEl && countEl) {
          const name = nameEl.textContent?.trim() || '';
          const count = countEl.textContent?.trim() || '';
          const iconClass = icon ? icon.className : '';
          
          result.topApplications.push({
            name: name,
            count: count,
            icon: iconClass
          });
        }
      });
    });

    // Get live test SMS
    const smsRows = document.querySelectorAll('#LiveTestSMS tr');
    smsRows.forEach(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length >= 3) {
        const nameEl = cells[0]?.querySelector('h6 a');
        const numberEl = cells[0]?.querySelector('p');
        const cliEl = cells[1]?.querySelector('.fw-semi-bold');
        const messageEl = cells[2];
        
        result.liveTestSMS.push({
          name: nameEl ? nameEl.textContent?.trim() : '',
          number: numberEl ? numberEl.textContent?.trim() : '',
          cli: cliEl ? cliEl.textContent?.trim() : '',
          message: messageEl ? messageEl.textContent?.trim() : ''
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
  if (!authSuccess) {
    throw new Error('Authentication failed');
  }
  
  consola.info('Fetching numbers...');
  await page.goto(`${baseUrl}/portal/numbers`, {
    waitUntil: 'networkidle2',
    timeout: 30000
  });

  const numbers = await page.evaluate(() => {
    const results = [];
    const rows = document.querySelectorAll('.table tbody tr');
    
    rows.forEach(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length >= 2) {
        const numberEl = cells[0]?.querySelector('.fw-semi-bold, .number');
        const statusEl = cells[1]?.querySelector('.badge, .status');
        
        const number = numberEl ? numberEl.textContent?.trim() : '';
        const status = statusEl ? statusEl.textContent?.trim() : '';
        
        if (number) {
          results.push({
            number: number,
            status: status || 'Unknown'
          });
        }
      }
    });
    
    return results;
  });

  return numbers;
}

// ============ MESSAGES ============
async function getMessages(page, number) {
  const authSuccess = await authenticate(page);
  if (!authSuccess) {
    throw new Error('Authentication failed');
  }
  
  consola.info(`Fetching messages for ${number}...`);
  
  await page.goto(`${baseUrl}/portal/sms/test/sms`, {
    waitUntil: 'networkidle2',
    timeout: 30000
  });

  const messages = await page.evaluate((searchNumber) => {
    const results = [];
    const rows = document.querySelectorAll('.table tbody tr');
    
    rows.forEach(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length >= 3) {
        const numberEl = cells[0]?.querySelector('.number, .fw-semi-bold');
        const messageEl = cells[1];
        const timeEl = cells[2];
        
        const numberText = numberEl ? numberEl.textContent?.trim() : '';
        const message = messageEl ? messageEl.textContent?.trim() : '';
        const time = timeEl ? timeEl.textContent?.trim() : '';
        
        if (!searchNumber || numberText.includes(searchNumber)) {
          if (message) {
            const otpMatch = message.match(/\b\d{4,6}\b/);
            results.push({
              number: numberText,
              message: message,
              time: time || 'now',
              otp: otpMatch ? otpMatch[0] : undefined
            });
          }
        }
      }
    });
    
    return results;
  }, number);

  return messages;
}

// ============ CHECK STATUS ============
async function checkLoginStatus() {
  if (!authCookies) return false;
  
  try {
    const browserInstance = await getBrowser();
    const page = await browserInstance.newPage();
    
    try {
      await page.setCookie(...authCookies);
      await page.goto(`${baseUrl}/portal`, {
        waitUntil: 'networkidle2',
        timeout: 10000
      });
      
      const url = page.url();
      return url.includes('/portal');
    } finally {
      await page.close().catch(() => {});
    }
  } catch (error) {
    return false;
  }
}

// ============ EXPRESS APP ============

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  skip: (req) => req.path === '/health',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.ip || req.connection.remoteAddress || 'unknown';
  }
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
    browser: browser ? 'connected' : 'disconnected',
    authenticated: isAuthenticated,
    environment: process.env.RAILWAY ? 'railway' : 'local',
    email: IVAS_EMAIL ? 'Set' : 'Not set'
  });
});

// ============ API ENDPOINTS ============

// Get portal/dashboard data
app.get('/api/portal', async (req, res) => {
  try {
    const browserInstance = await getBrowser();
    const page = await browserInstance.newPage();
    
    try {
      const data = await getPortalData(page);
      res.json({
        success: true,
        data: data
      });
    } finally {
      await page.close().catch(() => {});
    }
  } catch (error) {
    consola.error('Error fetching portal:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch portal data',
      message: error.message
    });
  }
});

// Get phone numbers
app.get('/api/numbers', async (req, res) => {
  try {
    const browserInstance = await getBrowser();
    const page = await browserInstance.newPage();
    
    try {
      const numbers = await getNumbers(page);
      res.json({
        success: true,
        numbers: numbers
      });
    } finally {
      await page.close().catch(() => {});
    }
  } catch (error) {
    consola.error('Error fetching numbers:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch numbers',
      message: error.message
    });
  }
});

// Get messages for a specific number
app.get('/api/messages/:number', async (req, res) => {
  try {
    const { number } = req.params;
    
    const browserInstance = await getBrowser();
    const page = await browserInstance.newPage();
    
    try {
      const messages = await getMessages(page, number);
      res.json({
        success: true,
        number: number,
        messages: messages
      });
    } finally {
      await page.close().catch(() => {});
    }
  } catch (error) {
    consola.error('Error fetching messages:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch messages',
      message: error.message
    });
  }
});

// Get live test SMS
app.get('/api/live-sms', async (req, res) => {
  try {
    const browserInstance = await getBrowser();
    const page = await browserInstance.newPage();
    
    try {
      const data = await getPortalData(page);
      res.json({
        success: true,
        liveSms: data.liveTestSMS || []
      });
    } finally {
      await page.close().catch(() => {});
    }
  } catch (error) {
    consola.error('Error fetching live SMS:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch live SMS',
      message: error.message
    });
  }
});

// Get top applications
app.get('/api/top-apps', async (req, res) => {
  try {
    const browserInstance = await getBrowser();
    const page = await browserInstance.newPage();
    
    try {
      const data = await getPortalData(page);
      res.json({
        success: true,
        topApplications: data.topApplications || []
      });
    } finally {
      await page.close().catch(() => {});
    }
  } catch (error) {
    consola.error('Error fetching top apps:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch top applications',
      message: error.message
    });
  }
});

// Login endpoint
app.post('/api/login', async (req, res) => {
  try {
    const browserInstance = await getBrowser();
    const page = await browserInstance.newPage();
    
    try {
      // Set viewport
      await page.setViewport({ width: 1280, height: 800 });
      
      const success = await authenticate(page);
      
      if (success) {
        // Try to get portal data
        try {
          const data = await getPortalData(page);
          res.json({
            success: true,
            message: 'Login successful',
            data: data
          });
        } catch (e) {
          res.json({
            success: true,
            message: 'Login successful but could not fetch data',
            error: e.message
          });
        }
      } else {
        res.status(401).json({
          success: false,
          error: 'Login failed. Please check your credentials or try again.'
        });
      }
    } finally {
      await page.close().catch(() => {});
    }
  } catch (error) {
    consola.error('Login error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Login failed',
      message: error.message
    });
  }
});

// Logout endpoint
app.post('/api/logout', async (req, res) => {
  try {
    authCookies = null;
    authSession = null;
    
    if (browser) {
      const pages = await browser.pages();
      for (const page of pages) {
        await page.deleteCookie(...await page.cookies()).catch(() => {});
      }
    }
    
    res.json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (error) {
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// Check login status
app.get('/api/status', async (req, res) => {
  const isAuthenticated = await checkLoginStatus();
  res.json({
    authenticated: isAuthenticated,
    email: IVAS_EMAIL ? 'Set' : 'Not set',
    sessionActive: !!authSession
  });
});

// Cleanup endpoint
app.post('/api/cleanup', async (req, res) => {
  try {
    if (browser) {
      await browser.close();
      browser = null;
      authCookies = null;
      authSession = null;
    }
    res.json({ success: true, message: 'Browser closed' });
  } catch (error) {
    res.status(500).json({ 
      success: false,
      error: 'Cleanup failed' 
    });
  }
});

// ============ START SERVER ============
const server = app.listen(PORT, '0.0.0.0', () => {
  consola.success(`🚀 Server running on port ${PORT}`);
  consola.info(`📍 Health check: http://localhost:${PORT}/health`);
  consola.info(`📱 API endpoints:`);
  consola.info(`   GET  /api/portal - Full dashboard data`);
  consola.info(`   GET  /api/numbers - Your phone numbers`);
  consola.info(`   GET  /api/messages/:number - Messages for a number`);
  consola.info(`   GET  /api/live-sms - Live test SMS`);
  consola.info(`   GET  /api/top-apps - Top applications`);
  consola.info(`   POST /api/login - Login to iVAS`);
  consola.info(`   POST /api/logout - Logout`);
  consola.info(`   GET  /api/status - Check login status`);
  consola.info(`🔧 Running on: ${process.env.RAILWAY ? 'Railway' : 'Local'}`);
  consola.info(`📧 Email: ${IVAS_EMAIL ? 'Set' : 'NOT SET'}`);
  consola.info(`🔑 Password: ${IVAS_PASSWORD ? 'Set' : 'NOT SET'}`);
});

// ============ GRACEFUL SHUTDOWN ============
async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  consola.info(`${signal} received, closing gracefully...`);
  
  server.close(() => {
    consola.info('HTTP server closed');
  });
  
  if (browser) {
    await browser.close();
    consola.info('Browser closed');
  }
  
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

export default app;
