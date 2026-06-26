import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer';
import { consola } from 'consola';
import rateLimit from 'express-rate-limit';

// ============ CONFIGURATION ============
const PORT = process.env.PORT || 3000;
const baseUrl = 'https://receive-sms-free.cc';
const defaultRecheckDelay = 5; // seconds

// ============ COUNTRY DATA ============
const Countries = {
  Finland: 'Finland',
  Sweden: 'Sweden',
  Netherlands: 'Netherlands',
  UK: 'UK',
  USA: 'USA',
  Belgium: 'Belgium',
  Slovenia: 'Slovenia'
};

const countries = Object.keys(Countries);

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

function stringifyTriggerOtpTimeDiff(askedAt) {
  const diff = Date.now() - askedAt;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function delay(seconds) {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

// ============ URL FUNCTIONS ============
function getCountryUrl(country) {
  if (!countries.includes(country)) return '';
  const countryMap = {
    'USA': 'USA',
    'UK': 'UK',
    'Finland': 'Finland',
    'Sweden': 'Sweden',
    'Netherlands': 'Netherlands',
    'Belgium': 'Belgium',
    'Slovenia': 'Slovenia'
  };
  return `${baseUrl}/Free-${countryMap[country]}-Phone-Number/`;
}

function getPhoneNumberUrl(country, phone) {
  const cleanPhone = phone.replace(/[^0-9]/g, '');
  const withCountryCode = country === 'USA' && !cleanPhone.startsWith('1') 
    ? `1${cleanPhone}` 
    : cleanPhone;
  return `${getCountryUrl(country)}${withCountryCode}/`;
}

// ============ BROWSER MANAGEMENT ============
let browser = null;
let isShuttingDown = false;

async function getBrowser() {
  if (!browser) {
    consola.info('Launching browser...');
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
          '--hide-scrollbars'
        ],
        timeout: 30000,
        ...(isRailway && {
          executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
        })
      });
      
      browser.on('disconnected', () => {
        consola.warn('Browser disconnected');
        browser = null;
      });
      
      consola.success('Browser launched successfully');
      
    } catch (error) {
      consola.error('Failed to launch browser:', error.message);
      throw error;
    }
  }
  return browser;
}

// ============ CORE FUNCTIONS ============
async function numberIsOnline(page, country, phoneNumber) {
  const url = getPhoneNumberUrl(country, phoneNumber);
  try {
    consola.info(`Checking URL: ${url}`);
    const result = await page.goto(url, { 
      waitUntil: 'networkidle2', 
      timeout: 15000 
    });
    
    // Check if page loaded and has messages
    const hasMessages = await page.evaluate(() => {
      const smsItems = document.querySelectorAll('.sms-item');
      return smsItems.length > 0;
    });
    
    return !!result && hasMessages;
  } catch (error) {
    consola.warn('Failed to check number online:', error.message);
    return false;
  }
}

async function parseMessages(page) {
  try {
    const currentUrl = page.url();
    
    // Parse SMS messages from the page
    const messages = await page.evaluate(() => {
      const results = [];
      const items = document.querySelectorAll('.sms-item');
      
      items.forEach(item => {
        const senderEl = item.querySelector('.sender-badge');
        const timeEl = item.querySelector('.time-text');
        const contentEl = item.querySelector('.sms-content');
        
        if (contentEl) {
          results.push({
            sender: senderEl ? senderEl.textContent?.trim() || '' : '',
            time: timeEl ? timeEl.textContent?.trim() || '' : '',
            message: contentEl.textContent?.trim() || ''
          });
        }
      });
      
      return results;
    });

    consola.info(`Found ${messages.length} messages on page`);

    return messages.map((msg) => ({
      ago: parseTimeAgo(msg.time) || Date.now(),
      agoText: msg.time || 'now',
      message: msg.message,
      sender: msg.sender,
      url: currentUrl,
      otp: tryParseOtpCode(msg.message)
    }));
  } catch (error) {
    consola.warn('Error parsing messages:', error.message);
    return [];
  }
}

async function recursivelyCheckMessages(page, askedAt, matcher, recheckDelay, attempts = 0) {
  try {
    // Wait a bit for messages to load
    await delay(2);
    
    // Refresh the page to get new messages
    await page.reload({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
    await delay(1);

    const parsed = (await parseMessages(page)) || [];
    if (!parsed.length) {
      if (attempts < 3) {
        consola.info(`No messages found, attempt ${attempts + 1}/3, retrying...`);
        await delay(recheckDelay);
        return recursivelyCheckMessages(page, askedAt, matcher, recheckDelay, attempts + 1);
      }
      return [];
    }

    const matches = parsed.filter(
      (parsed) =>
        parsed?.ago >= askedAt &&
        (Array.isArray(matcher) 
          ? matcher.some((m) => parsed?.message?.toLowerCase().includes(m.toLowerCase())) 
          : parsed?.message?.toLowerCase().includes(matcher.toLowerCase()))
    );

    if (matches.length) {
      consola.success(`Found ${matches.length} matching messages!`);
      return matches;
    }

    consola.info(
      `Not found message within ${stringifyTriggerOtpTimeDiff(askedAt)} range, latest ${
        parsed[0]?.agoText || 'unknown'
      }, will try after ${recheckDelay}s...`
    );

    await delay(recheckDelay);
    return recursivelyCheckMessages(page, askedAt, matcher, recheckDelay, 0);
  } catch (error) {
    consola.warn('Error in recursive check:', error.message);
    return [];
  }
}

async function handleReceiveSmsFreeCC(page, options) {
  consola.start('Starting automated check for OTP');
  consola.start(`Checking number is online at ${baseUrl}`);
  const isAlive = await numberIsOnline(page, options.country, options.phoneNumber);
  if (!isAlive) {
    throw new Error('Number is offline or unreachable');
  }

  consola.success(`Number ${options.phoneNumber} is online`);

  const match = await recursivelyCheckMessages(
    page,
    options.askedOtpAt || 0,
    options.matcher,
    options?.interval || defaultRecheckDelay
  );

  return match;
}

async function parseNumbersPage(page, country, url) {
  try {
    consola.info(`Navigating to: ${url}`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
    
    // Wait for content to load
    await page.waitForSelector('#numbersGrid', { timeout: 10000 }).catch(() => {});
    await delay(2);

    // Extract phone numbers from the page
    const numbers = await page.evaluate(() => {
      const results = [];
      const cards = document.querySelectorAll('.number-card');
      
      cards.forEach(card => {
        const link = card.closest('a');
        if (link) {
          const href = link.href;
          // Extract phone number from href
          const match = href.match(/\/(\d+)\/$/);
          if (match) {
            results.push(match[1]);
          }
        }
      });
      
      return results;
    });

    consola.success(`Parsed ${numbers.length} phone numbers`);

    // Check for pagination
    let nextPageUrl = null;
    try {
      const paginationLinks = await page.$$eval('.pagination a', (links) => {
        for (const link of links) {
          if (link.textContent?.includes('»') || link.textContent?.includes('Next')) {
            return link.href;
          }
        }
        return null;
      });
      
      if (paginationLinks && paginationLinks !== url) {
        nextPageUrl = paginationLinks;
        consola.success(`Found next page: ${nextPageUrl}`);
      }
    } catch (e) {
      consola.info('No pagination found');
    }

    return {
      numbers: numbers,
      nextPageUrl
    };
  } catch (error) {
    consola.error('Error parsing numbers page:', error.message);
    return { numbers: [] };
  }
}

async function getReceiveSmsFreePhones(page, country, nextUrl) {
  consola.start(`Starting parsing numbers for ${country}`);
  const url = nextUrl ?? getCountryUrl(country);

  if (!url) {
    consola.error(`Invalid URL for country: ${country}`);
    return { phones: [] };
  }

  consola.info(`Using URL: ${url}`);

  const { numbers, nextPageUrl } = await parseNumbersPage(page, country, url);

  return {
    phones: numbers.map((phone) => ({ 
      phone, 
      url: getPhoneNumberUrl(country, phone) 
    })),
    nextPageUrl
  };
}

// ============ EXPRESS APP ============
const app = express();

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  skip: (req) => req.path === '/health'
});

app.use(cors());
app.use(express.json());
app.use('/api/', limiter);

// ============ HEALTH CHECK ============
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    service: 'sms-receiver',
    browser: browser ? 'connected' : 'disconnected',
    environment: process.env.RAILWAY ? 'railway' : 'local'
  });
});

// ============ API ENDPOINTS ============

// Get available countries
app.get('/api/countries', (req, res) => {
  res.json({ 
    success: true,
    countries: ['USA', 'UK', 'Finland', 'Sweden', 'Netherlands', 'Belgium', 'Slovenia']
  });
});

// Get phone numbers for a country
app.get('/api/numbers/:country', async (req, res) => {
  try {
    const { country } = req.params;
    const { page } = req.query;
    
    const validCountries = ['USA', 'UK', 'Finland', 'Sweden', 'Netherlands', 'Belgium', 'Slovenia'];
    if (!country || !validCountries.includes(country)) {
      return res.status(400).json({ error: 'Invalid country' });
    }

    const browserInstance = await getBrowser();
    const pageInstance = await browserInstance.newPage();
    
    try {
      const result = await getReceiveSmsFreePhones(
        pageInstance,
        country,
        page || undefined
      );
      
      res.json({
        success: true,
        country,
        ...result
      });
    } finally {
      await pageInstance.close().catch(() => {});
    }
  } catch (error) {
    consola.error('Error fetching numbers:', error);
    res.status(500).json({ 
      error: 'Failed to fetch phone numbers',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Get messages for a specific phone number
app.get('/api/messages/:country/:phone', async (req, res) => {
  try {
    const { country, phone } = req.params;
    
    const browserInstance = await getBrowser();
    const pageInstance = await browserInstance.newPage();
    
    try {
      const url = getPhoneNumberUrl(country, phone);
      await pageInstance.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
      
      const messages = await parseMessages(pageInstance);
      
      res.json({
        success: true,
        country,
        phone,
        messages
      });
    } finally {
      await pageInstance.close().catch(() => {});
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Wait for OTP message
app.post('/api/wait-for-otp', async (req, res) => {
  try {
    const { 
      country, 
      phoneNumber, 
      matcher, 
      askedOtpAt,
      interval = 5,
      timeout = 180000 
    } = req.body;

    if (!country || !phoneNumber || !matcher) {
      return res.status(400).json({ 
        error: 'Missing required fields: country, phoneNumber, matcher' 
      });
    }

    const browserInstance = await getBrowser();
    const pageInstance = await browserInstance.newPage();
    
    try {
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Timeout waiting for OTP')), timeout);
      });

      const otpPromise = handleReceiveSmsFreeCC(pageInstance, {
        country,
        phoneNumber,
        matcher,
        askedOtpAt: askedOtpAt || Date.now(),
        interval
      });

      const result = await Promise.race([otpPromise, timeoutPromise]);
      
      res.json({
        success: true,
        ...result
      });
    } finally {
      await pageInstance.close().catch(() => {});
    }
  } catch (error) {
    consola.error('Error waiting for OTP:', error);
    res.status(500).json({ 
      error: 'Failed to get OTP',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Get phone number URL
app.get('/api/phone-url/:country/:phone', (req, res) => {
  try {
    const { country, phone } = req.params;
    
    if (!country || !phone) {
      return res.status(400).json({ error: 'Missing country or phone' });
    }

    const url = getPhoneNumberUrl(country, phone);
    const countryUrl = getCountryUrl(country);
    
    res.json({
      success: true,
      url,
      countryUrl,
      country,
      phone
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate URL' });
  }
});

// Debug endpoint
app.get('/api/debug/:country', async (req, res) => {
  try {
    const { country } = req.params;
    const browserInstance = await getBrowser();
    const pageInstance = await browserInstance.newPage();
    
    try {
      const url = getCountryUrl(country);
      await pageInstance.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
      
      const debug = await pageInstance.evaluate(() => {
        const numbers = [];
        const cards = document.querySelectorAll('.number-card');
        cards.forEach(card => {
          const link = card.closest('a');
          if (link) {
            numbers.push(link.href);
          }
        });
        
        return {
          title: document.title,
          url: window.location.href,
          numberCardsFound: cards.length,
          numbers: numbers.slice(0, 10),
          pageText: document.body.innerText.substring(0, 500)
        };
      });
      
      res.json({
        success: true,
        url,
        debug
      });
    } finally {
      await pageInstance.close().catch(() => {});
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Cleanup endpoint
app.post('/api/cleanup', async (req, res) => {
  try {
    if (browser) {
      await browser.close();
      browser = null;
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
  consola.info(`   GET  /api/countries`);
  consola.info(`   GET  /api/numbers/:country`);
  consola.info(`   GET  /api/messages/:country/:phone`);
  consola.info(`   POST /api/wait-for-otp`);
  consola.info(`   GET  /api/debug/:country`);
  consola.info(`🔧 Running on: ${process.env.RAILWAY ? 'Railway' : 'Local'}`);
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
