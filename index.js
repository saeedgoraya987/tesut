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

// ============ AUTHENTICATION ============
async function authenticate(page) {
  if (authCookies && authSession) {
    consola.info('Using existing session');
    return true;
  }

  if (!IVAS_EMAIL || !IVAS_PASSWORD) {
    consola.error('IVAS_EMAIL and IVAS_PASSWORD environment variables must be set');
    throw new Error('Missing credentials. Set IVAS_EMAIL and IVAS_PASSWORD environment variables.');
  }

  consola.info('Authenticating to iVAS...');
  
  try {
    await page.goto(`${baseUrl}/login`, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // Get CSRF token
    const token = await page.evaluate(() => {
      const tokenInput = document.querySelector('input[name="_token"]');
      return tokenInput ? tokenInput.value : null;
    });
    consola.info(`CSRF Token: ${token || 'Not found'}`);

    // Fill in login form
    await page.type('#card-email', IVAS_EMAIL);
    await page.type('#card-password', IVAS_PASSWORD);

    // Check "Remember me"
    await page.click('#card-checkbox').catch(() => {});

    // Wait for Cloudflare Turnstile to complete
    consola.info('Waiting for Cloudflare Turnstile...');
    await page.waitForSelector('.cf-turnstile', { timeout: 15000 }).catch(() => {});
    await delay(5);

    // Submit the form
    consola.info('Submitting login form...');
    await page.evaluate(() => {
      const form = document.querySelector('form');
      if (form) form.submit();
    });

    // Wait for navigation to portal
    await page.waitForNavigation({
      waitUntil: 'networkidle2',
      timeout: 30000
    }).catch(() => {});

    const currentUrl = page.url();
    consola.info(`Current URL after login: ${currentUrl}`);
    
    if (currentUrl.includes('/portal') || currentUrl.includes('/dashboard')) {
      consola.success('Authentication successful!');
      
      authCookies = await page.cookies();
      authSession = {
        url: currentUrl,
        timestamp: Date.now()
      };
      
      return true;
    } else {
      const errorMessage = await page.evaluate(() => {
        const errorEl = document.querySelector('.alert-danger, .alert-error, .invalid-feedback, .text-danger');
        return errorEl ? errorEl.textContent?.trim() : null;
      });
      
      consola.error('Authentication failed:', errorMessage || 'Unknown error');
      return false;
    }
  } catch (error) {
    consola.error('Authentication error:', error.message);
    return false;
  }
}

// ============ PORTAL / DASHBOARD ============
async function getPortalData(page) {
  await authenticate(page);
  
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
  await authenticate(page);
  
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
  await authenticate(page);
  
  consola.info(`Fetching messages for ${number}...`);
  
  // Try to find messages - could be in different sections
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
        
        // If searching for specific number, filter
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
      error: 'Failed to fetch top applications',
      message: error.message
    });
  }
});

// Login endpoint
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    const useEmail = email || IVAS_EMAIL;
    const usePassword = password || IVAS_PASSWORD;
    
    if (!useEmail || !usePassword) {
      return res.status(400).json({
        error: 'Email and password required. Set IVAS_EMAIL and IVAS_PASSWORD env vars or provide in request.'
      });
    }
    
    const browserInstance = await getBrowser();
    const page = await browserInstance.newPage();
    
    try {
      const originalEmail = IVAS_EMAIL;
      const originalPassword = IVAS_PASSWORD;
      
      process.env.IVAS_EMAIL = useEmail;
      process.env.IVAS_PASSWORD = usePassword;
      
      authCookies = null;
      authSession = null;
      
      const success = await authenticate(page);
      
      process.env.IVAS_EMAIL = originalEmail;
      process.env.IVAS_PASSWORD = originalPassword;
      
      if (success) {
        res.json({
          success: true,
          message: 'Login successful',
          redirect: '/portal'
        });
      } else {
        res.status(401).json({
          success: false,
          error: 'Login failed. Please check your credentials.'
        });
      }
    } finally {
      await page.close().catch(() => {});
    }
  } catch (error) {
    consola.error('Login error:', error);
    res.status(500).json({ 
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
    res.status(500).json({ error: error.message });
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
    res.status(500).json({ error: 'Cleanup failed' });
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
  consola.info(`📧 Email: ${IVAS_EMAIL ? 'Set' : 'NOT SET - Please set IVAS_EMAIL'}`);
  consola.info(`🔑 Password: ${IVAS_PASSWORD ? 'Set' : 'NOT SET - Please set IVAS_PASSWORD'}`);
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
