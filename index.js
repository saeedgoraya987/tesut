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
  const otpMatch = message.match(/\b\d{4,6}\b/);
  return otpMatch ? otpMatch[0] : undefined;
}

function parseTimeAgo(agoText) {
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
  return `${baseUrl}/Free-${Countries[country]}-Phone-Number/`;
}

function getPhoneNumberUrl(country, phone) {
  const withCountryCode = country === 'USA' && !phone.startsWith('+') && !phone.startsWith('1') 
    ? `1${phone}` 
    : phone;
  return `${getCountryUrl(country)}${withCountryCode.replace('+', '')}/`;
}

// ============ BROWSER MANAGEMENT ============
let browser = null;
let isShuttingDown = false;

async function getBrowser() {
  if (!browser) {
    consola.info('Launching browser...');
    try {
      browser = await puppeteer.launch({
        headless: 'new',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--disable-web-security',
          '--disable-features=IsolateOrigins,site-per-process'
        ],
        timeout: 30000
      });
      
      browser.on('disconnected', () => {
        consola.warn('Browser disconnected');
        browser = null;
      });
      
    } catch (error) {
      consola.error('Failed to launch browser:', error);
      throw error;
    }
  }
  return browser;
}

// ============ CORE FUNCTIONS ============
async function numberIsOnline(page, country, phoneNumber) {
  const url = getPhoneNumberUrl(country, phoneNumber);
  const result = await page.goto(url);
  return !!result;
}

async function parseMessages(page) {
  const currentUrl = page.url();
  const rowLocator = '.casetext > .row';

  const messageRows = await page.$$eval(rowLocator, (rows) =>
    rows.map((row) => ({
      ago: row.children[1]?.textContent ?? '',
      message: row.children[2]?.textContent ?? ''
    }))
  );

  return messageRows
    .filter((row) => row.ago.length && row.message.length)
    .map((row) => {
      const agoParsed = parseTimeAgo(row.ago);
      return {
        ago: agoParsed,
        agoText: row.ago,
        message: row.message,
        url: currentUrl
      };
    })
    .filter((message) => message.ago);
}

async function recursivelyCheckMessages(page, askedAt, matcher, recheckDelay) {
  await page.waitForNetworkIdle({ idleTime: 500 });

  const parsed = (await parseMessages(page)) || [];
  if (!parsed.length) {
    return [];
  }

  const matches = parsed.filter(
    (parsed) =>
      parsed?.ago >= askedAt &&
      (Array.isArray(matcher) 
        ? matcher.some((m) => parsed?.message?.includes(m)) 
        : parsed?.message?.includes(matcher))
  );

  if (matches.length) {
    return matches.map((match) => ({
      ...match,
      otp: tryParseOtpCode(match.message)
    }));
  }

  const match = matches.at(0);

  if (match) {
    match.otp = tryParseOtpCode(match.message);
    return match;
  }

  consola.info(
    `not found message within ${stringifyTriggerOtpTimeDiff(askedAt)} range, latest ${
      parsed.shift()?.agoText
    }, will try after ${recheckDelay}s...`
  );

  const buttons = await page.$$('.btn-primary');
  await buttons.at(0)?.click();

  const currentUrl = page.url();
  if (!currentUrl.includes(baseUrl)) {
    await page.waitForNavigation();
  }

  await delay(recheckDelay);
  return recursivelyCheckMessages(page, askedAt, matcher, recheckDelay);
}

async function handleReceiveSmsFreeCC(page, options) {
  consola.start(`starting automated check for otp`);
  consola.start(`checking number is online at ${baseUrl}`);
  const isAlive = await numberIsOnline(page, options.country, options.phoneNumber);
  if (!isAlive) {
    throw new Error('number is offline');
  }

  consola.success(`number ${options.phoneNumber} is online`);

  const match = await recursivelyCheckMessages(
    page,
    options.askedOtpAt || 0,
    options.matcher,
    options?.interval || defaultRecheckDelay
  );

  return match;
}

async function elementExist(page, locator) {
  return (await page.$(locator).catch(() => null)) !== null;
}

async function parseNumbersPage(page, country, url) {
  await page.goto(url);
  consola.start(`parsing page ${page.url()}...`);
  await page.waitForSelector('.section04 .index-title', { timeout: 5000 });
  await page.waitForSelector('.layout .index-case', { timeout: 5000 });
  await delay(1);

  const phoneNumberElementsLocator = 'li a[href] > h2 > span';
  const currentPagePhones = await page.$$eval(phoneNumberElementsLocator, (elements) =>
    elements.map((el) => el?.textContent)
  );

  const numbers = currentPagePhones
    .filter((phone) => Boolean(phone))
    .map((phone) => phone.replace('+1', '').replaceAll(' ', ''));

  const paginationLocator = '.pagination > li.active + li a';
  const nextPageAvailable = await elementExist(page, paginationLocator);

  if (!nextPageAvailable) {
    return { numbers };
  }
  consola.success(`can see pagination element`);

  const nextPageFromPagination = await page.$eval(paginationLocator, (el) => el?.href);

  if (!nextPageFromPagination || nextPageFromPagination === url) {
    return { numbers };
  }

  const nextPageHtml = nextPageFromPagination.split('/').pop();

  if (!nextPageHtml) {
    return { numbers };
  }

  const nextPageUrl = `${getCountryUrl(country)}${nextPageHtml}`;

  if (nextPageUrl === url) {
    return { numbers };
  }

  return {
    numbers,
    nextPageUrl
  };
}

async function getReceiveSmsFreePhones(page, country, nextUrl) {
  consola.start(`starting parsing numbers for ${country.toString()}`);
  const url = nextUrl ?? getCountryUrl(country);

  consola.success(`got url ${url}`);

  if (!url) {
    return { phones: [] };
  }

  const { numbers, nextPageUrl } = await parseNumbersPage(page, country, url);

  return {
    phones: numbers.map((phone) => ({ phone, url: getPhoneNumberUrl(country, phone) })),
    nextPageUrl
  };
}

// ============ EXPRESS APP ============
const app = express();

// Rate limiting to prevent abuse
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
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
    browser: browser ? 'connected' : 'disconnected'
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

// Wait for OTP message
app.post('/api/wait-for-otp', async (req, res) => {
  try {
    const { 
      country, 
      phoneNumber, 
      matcher, 
      askedOtpAt,
      interval = 5000,
      timeout = 120000 
    } = req.body;

    if (!country || !phoneNumber || !matcher) {
      return res.status(400).json({ 
        error: 'Missing required fields: country, phoneNumber, matcher' 
      });
    }

    const browserInstance = await getBrowser();
    const pageInstance = await browserInstance.newPage();
    
    try {
      // Set timeout for the entire operation
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

// Get specific phone number URL
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

// Cleanup endpoint (for testing)
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
const server = app.listen(PORT, () => {
  consola.success(`🚀 Server running on port ${PORT}`);
  consola.info(`📍 Health check: http://localhost:${PORT}/health`);
  consola.info(`📱 API endpoints available at /api/`);
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
