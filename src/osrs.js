import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import * as brevo from '@getbrevo/brevo';

// Get directory name for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load package.json for app name and version
const require = createRequire(import.meta.url);
const pkg = require('../package.json');

// OSRS constants
// Dynamically construct USER_AGENT from GitHub Actions environment
const getGitHubEmail = () => {
  const actor = process.env.GITHUB_ACTOR;
  if (!actor) {
    throw new Error('GITHUB_ACTOR environment variable not set');
  }
  return `${actor}@users.noreply.github.com`;
};

const getRepoUrl = () => {
  const serverUrl = process.env.GITHUB_SERVER_URL;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!serverUrl || !repository) {
    throw new Error('GitHub environment variables (GITHUB_SERVER_URL, GITHUB_REPOSITORY) not set');
  }
  return `${serverUrl}/${repository}`;
};

const USER_AGENT = `${pkg.name}/${pkg.version} (${getGitHubEmail()}; +${getRepoUrl()})`;

// Path to local history file
const HISTORY_FILE = path.join(__dirname, '..', 'data', 'osrs-history.json');

// ===== LOCAL HISTORY FUNCTIONS =====

/**
 * Loads historical data from local file
 * @returns {Object} Historical data by item ID
 */
function loadHistoricalData() {
  if (!fs.existsSync(HISTORY_FILE)) {
    console.log('📝 Creating new history file...');
    fs.writeFileSync(HISTORY_FILE, JSON.stringify({}));
    return {};
  }
  return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
}

/**
 * Saves updated historical data (minified for space efficiency)
 * @param {Object} data - Historical data to save
 */
function saveHistoricalData(data) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(data));
}

/**
 * Updates local history with today's data from Weirdgloop API
 * @param {number} itemId - The OSRS item ID
 * @param {string} itemName - The item name
 * @param {number} currentPrice - Today's price from Weirdgloop
 * @param {number} volume - Today's volume from Weirdgloop
 * @returns {Object} Full price and volume history for the item
 */
function updateLocalHistory(itemId, itemName, currentPrice, volume) {
  const historicalData = loadHistoricalData();
  
  // Initialize item if it doesn't exist
  if (!historicalData[itemId]) {
    historicalData[itemId] = {
      name: itemName,
      daily: {},
      volume: {}
    };
  }
  
  // Update item name in case it changed
  historicalData[itemId].name = itemName;
  
  // Get today's timestamp (midnight UTC)
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const todayTimestamp = today.getTime();
  
  // Update or append today's price and volume
  historicalData[itemId].daily[todayTimestamp] = currentPrice;
  historicalData[itemId].volume[todayTimestamp] = volume;
  
  // Save updated history
  saveHistoricalData(historicalData);
  
  return { 
    daily: historicalData[itemId].daily,
    volume: historicalData[itemId].volume
  };
}

// ===== API FUNCTIONS =====

/**
 * Gets price history for an item from local storage
 * Updates with today's data from the item database
 * @param {number} itemId - The OSRS item ID
 * @param {string} itemName - The item name
 * @param {number} currentPrice - Today's price
 * @param {number} volume - Today's volume
 * @returns {Object} Price data with timestamps and values
 */
function getPriceHistory(itemId, itemName, currentPrice, volume) {
  // Update local history with today's data
  return updateLocalHistory(itemId, itemName, currentPrice, volume);
}

/**
 * Fetches item data from the OSRS item database
 * @returns {Promise<Object>} Item data
 */
async function fetchItemDatabase() {
  // We have to use this database because the official API does not provide volume data
  const url = 'https://chisel.weirdgloop.org/gazproj/gazbot/os_dump.json';
  console.log('Fetching item database...');
  
  try {
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': USER_AGENT
      }
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch item database: ${response.status}`);
    }
    const data = await response.json();
    console.log('✅ Item database loaded\n');
    return data;
  } catch (error) {
    console.error('Error fetching item database:', error.message);
    process.exit(1);
  }
}

// ===== ANALYSIS FUNCTIONS =====

/**
 * Converts price history object to sorted array of price points
 * @param {Object} priceData - Raw price data from API (timestamp: price)
 * @returns {Array} Sorted array of {timestamp, price} objects
 */
function convertToArray(priceData) {
  return Object.entries(priceData)
    .map(([timestamp, price]) => ({
      timestamp: parseInt(timestamp),
      price: price
    }))
    .sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Calculates the percentage change in price over the period
 * @param {Array} prices - Array of price points
 * @returns {number} Percentage change
 */
function calculatePriceChange(prices) {
  if (prices.length < 2) return 0;
  
  const firstPrice = prices[0].price;
  const lastPrice = prices[prices.length - 1].price;
  
  return ((lastPrice - firstPrice) / firstPrice) * 100;
}

/**
 * Calculates price volatility (standard deviation)
 * @param {Array} prices - Array of price points
 * @returns {number} Volatility as percentage of mean
 */
function calculateVolatility(prices) {
  if (prices.length < 2) return 0;
  
  const priceValues = prices.map(p => p.price);
  const mean = priceValues.reduce((a, b) => a + b, 0) / priceValues.length;
  
  const squaredDiffs = priceValues.map(price => Math.pow(price - mean, 2));
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / priceValues.length;
  const stdDev = Math.sqrt(variance);
  
  return (stdDev / mean) * 100;
}

/**
 * Calculates recent momentum (30-day vs 60-day average)
 * @param {Array} prices - Array of price points
 * @returns {number} Momentum score
 */
function calculateMomentum(prices) {
  if (prices.length < 60) return 0;
  
  const recent30 = prices.slice(-30);
  const previous30 = prices.slice(-60, -30);
  
  const recent30Avg = recent30.reduce((sum, p) => sum + p.price, 0) / recent30.length;
  const previous30Avg = previous30.reduce((sum, p) => sum + p.price, 0) / previous30.length;
  
  return ((recent30Avg - previous30Avg) / previous30Avg) * 100;
}

/**
 * Calculates an investment score based on multiple factors
 * @param {number} priceChange - Overall price change percentage
 * @param {number} volatility - Price volatility percentage
 * @param {number} momentum - Recent momentum score
 * @returns {number} Investment score (0-100)
 */
function calculateInvestmentScore(priceChange, volatility, momentum) {
  // Strategy: High-volatility items with strong momentum for ROI potential
  let score = 50; // Base score
  
  // High volatility is GOOD for this strategy (up to +30 points)
  // Items with 20%+ volatility get max points
  if (volatility >= 20) {
    score += 30;
  } else {
    score += (volatility / 20) * 30;
  }
  
  // Strong positive momentum is critical (up to +30 points)
  score += Math.min(momentum * 3, 30);
  
  // Recent strong price change indicates potential (up to +30 points)
  // Looking for items that have moved 40%+ already
  if (priceChange >= 40) {
    score += 30;
  } else if (priceChange > 0) {
    score += (priceChange / 40) * 30;
  }
  
  // Bonus for items showing breakout potential
  if (momentum > 10 && priceChange > 30 && volatility > 15) {
    score += 10; // Hot item bonus
  }
  
  return Math.max(0, Math.min(100, score));
}

/**
 * Categorizes volume into descriptive levels
 * @param {number} volume - Trading volume
 * @returns {string} Volume category
 */
function categorizeVolume(volume) {
  if (volume >= 1000000) return 'Very High';
  if (volume >= 100000) return 'High';
  if (volume >= 10000) return 'Medium';
  if (volume >= 1000) return 'Low';
  return 'Very Low';
}

/**
 * Analyzes an item's price history
 * @param {Object} priceData - Raw price data from API
 * @param {Object} itemInfo - Item name, ID, membership status, and volume
 * @returns {Object} Analysis results
 */
function analyzeItem(priceData, itemInfo) {
  if (!priceData || !priceData.daily) {
    return null;
  }
  
  const prices = convertToArray(priceData.daily);
  
  if (prices.length === 0) {
    return null;
  }
  
  const priceChange = calculatePriceChange(prices);
  const volatility = calculateVolatility(prices);
  const momentum = calculateMomentum(prices);
  
  const currentPrice = prices[prices.length - 1].price;
  const startPrice = prices[0].price;
  
  const investmentScore = calculateInvestmentScore(priceChange, volatility, momentum);
  
  // Determine risk level based on volatility
  // High risk: volatility >= 15%
  // Low risk: volatility < 15%
  const riskLevel = parseFloat(volatility) >= 15 ? 'high' : 'low';
  
  return {
    id: itemInfo.id,
    name: itemInfo.name,
    currentPrice,
    startPrice,
    priceChange: priceChange.toFixed(2),
    volume: itemInfo.volume || 0,
    volumeCategory: categorizeVolume(itemInfo.volume || 0),
    volatility: volatility.toFixed(2),
    momentum: momentum.toFixed(2),
    investmentScore: investmentScore.toFixed(1),
    dataPoints: prices.length,
    members: itemInfo.members,
    riskLevel: riskLevel
  };
}

// ===== MAIN APPLICATION =====

/**
 * Automated OSRS analysis
 * @param {Object} options - Configuration options
 * @returns {Promise<Object>} Analysis results
 */
export async function runOSRSAutomated(options = {}) {
  const { isGitHubActions = false, logFile = null } = options;
  
  const logMessage = (message) => {
    console.log(message);
    if (logFile) {
      const timestamp = new Date().toISOString();
      fs.appendFileSync(logFile, `${timestamp}: ${message}\n`);
    }
  };

  logMessage('🚀 OSRS Investment Analyzer (Automated)');
  logMessage('======================================');
  
  logMessage(`Analyzing ALL items (Members + F2P)`);
  logMessage(`Mode: ${isGitHubActions ? 'GitHub Actions' : 'Local'}`);
  logMessage('');

  // Fetch item data
  logMessage('Fetching OSRS item database...');
  const itemsData = await fetchItemDatabase();
  
  if (!itemsData) {
    throw new Error('Failed to fetch OSRS item data');
  }

  // Filter items - include both members and F2P
  const allItems = Object.entries(itemsData)
    .filter(([id, item]) => {
      // Only require basic data to be present
      if (!item.name || item.price === undefined || item.volume === undefined) {
        return false;
      }
      return true;
    })
    .map(([id, item]) => ({
      id: parseInt(id),
      name: item.name,
      members: item.members !== false, // true if members item, false if F2P
      volume: item.volume
    }));

  logMessage(`Found ${allItems.length} suitable items`);
  
  // Analyze ALL suitable items (no limit)
  const shuffledItems = [...allItems].sort(() => Math.random() - 0.5);
  const itemsToAnalyze = shuffledItems;
  
  logMessage(`Analyzing ALL ${itemsToAnalyze.length} items...`);
  logMessage('');

  const results = [];
  let itemsChecked = 0;
  let successfulAnalyses = 0;

  for (let i = 0; i < itemsToAnalyze.length; i++) {
    const item = itemsToAnalyze[i];
    itemsChecked++;
    
    // Progress update for every item
    logMessage(`Progress: ${itemsChecked}/${itemsToAnalyze.length} - Checking ${item.name}...`);
    
    // Get current price from the item database (already fetched)
    const itemData = itemsData[item.id];
    const currentPrice = itemData.price;
    
    // Get price history from local storage (no API call needed!)
    const priceData = getPriceHistory(item.id, item.name, currentPrice, item.volume);
    
    if (priceData) {
      const analysis = analyzeItem(priceData, item);
      
      if (analysis) {
        results.push(analysis);
        successfulAnalyses++;
        logMessage(`  ✓ Analyzed (${successfulAnalyses} total)`);
      }
    }
    
    // No delay needed - we're just reading/writing local files now!
  }

  logMessage('');
  logMessage(`✅ OSRS Analysis Complete! Analyzed ${successfulAnalyses} items`);

  // Categorize results into 4 groups
  const highRiskMembers = results.filter(r => r.members && r.riskLevel === 'high')
    .sort((a, b) => parseFloat(b.investmentScore) - parseFloat(a.investmentScore))
    .slice(0, 3);
  
  const lowRiskMembers = results.filter(r => r.members && r.riskLevel === 'low')
    .sort((a, b) => parseFloat(b.investmentScore) - parseFloat(a.investmentScore))
    .slice(0, 3);
  
  const highRiskF2P = results.filter(r => !r.members && r.riskLevel === 'high')
    .sort((a, b) => parseFloat(b.investmentScore) - parseFloat(a.investmentScore))
    .slice(0, 3);
  
  const lowRiskF2P = results.filter(r => !r.members && r.riskLevel === 'low')
    .sort((a, b) => parseFloat(b.investmentScore) - parseFloat(a.investmentScore))
    .slice(0, 3);

  return {
    highRiskMembers,
    lowRiskMembers,
    highRiskF2P,
    lowRiskF2P,
    totalAnalyzed: successfulAnalyses,
    totalChecked: itemsChecked
  };
}

// ===== EMAIL REPORT GENERATION =====

/**
 * Formats GP amount with appropriate suffix
 * @param {number} amount - GP amount
 * @returns {string} Formatted string
 */
function formatGP(amount) {
  return `${amount.toLocaleString()} gold`;
}

/**
 * Generates HTML email report from OSRS analysis results
 * @param {Object} osrsData - OSRS analysis results
 * @returns {string} HTML email report
 */
function generateEmailReport(osrsData) {
  const currentDate = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  let contentHtml = '';
  
  if (osrsData.error) {
    contentHtml = `
      <div class="error">
        <p><strong>❌ Analysis Failed:</strong> ${osrsData.error}</p>
      </div>
    `;
  } else {
    const { highRiskMembers = [], lowRiskMembers = [], highRiskF2P = [], lowRiskF2P = [], metadata = {} } = osrsData;
    
    // Helper function to generate items HTML
    const generateItemsHtml = (items, category) => {
      if (items.length === 0) {
        return '<p class="no-items">No items found</p>';
      }
      return items.map((item) => `
            <div class="grid-item">
              <table>
                <tr>
                  <td style="width: 32px; vertical-align: top;">
                    <img src="https://secure.runescape.com/m=itemdb_oldschool/a=13/1762340401310_obj_sprite.gif?id=${item.id}" alt="${item.name}">
                  </td>
                  <td class="grid-item-content" style="vertical-align: top;">
                    <h4><a href="https://secure.runescape.com/m=itemdb_oldschool/viewitem?obj=${item.id}" target="_blank" style="color: #333; text-decoration: none;">${item.name}</a></h4>
                    <div class="item-metrics">
                      <span>Price: ${formatGP(item.currentPrice)}</span>
                      <span>Volume: ${item.volumeCategory}</span>
                      <span>Volatility: ${item.volatility}%</span>
                      <span>Momentum: ${item.momentum > 0 ? '+' : ''}${item.momentum}%</span>
                    </div>
                  </td>
                </tr>
              </table>
            </div>`).join('\n');
    };

    contentHtml = `
      <h2 style="text-align: center; margin-top: 0;">Recommendations</h2>
      
      <table class="grid-container">
        <tr>
          <td class="grid-section">
            <h3>High Risk — Members</h3>
            <div class="grid-items">
${generateItemsHtml(highRiskMembers, 'high-risk-members')}
            </div>
          </td>
        </tr>
        <tr>
          <td class="grid-section">
            <h3>Low Risk — Members</h3>
            <div class="grid-items">
${generateItemsHtml(lowRiskMembers, 'low-risk-members')}
            </div>
          </td>
        </tr>
        <tr>
          <td class="grid-section">
            <h3>High Risk — Free to Play</h3>
            <div class="grid-items">
${generateItemsHtml(highRiskF2P, 'high-risk-f2p')}
            </div>
          </td>
        </tr>
        <tr>
          <td class="grid-section">
            <h3>Low Risk — Free to Play</h3>
            <div class="grid-items">
${generateItemsHtml(lowRiskF2P, 'low-risk-f2p')}
            </div>
          </td>
        </tr>
      </table>
    `;
  }

  // Read existing index.html and update only the dynamic content
  let template = fs.readFileSync('docs/osrs/index.html', 'utf8');
  
  // Update the date
  template = template.replace(
    /<span id="report-date">.*?<\/span>/,
    `<span id="report-date">${currentDate}</span>`
  );
  
  // Update the content section (main grid area only, preserve opinion column)
  template = template.replace(
    /<div class="content">[\s\S]*?<\/div>\s*<aside class="opinion-column">/,
    `<div class="content">\n${contentHtml}\n    </div>\n    \n    <aside class="opinion-column">`
  );
  
  return template;
}

// ===== NEWSLETTER FUNCTIONS =====

/**
 * Loads OSRS subscriber list from Brevo contact list
 * @returns {Promise<Array>} Array of subscriber email addresses
 */
async function loadSubscribers() {
  const apiKey = process.env.BREVO_API_KEY;
  const listId = 4; // OSRS Newsletter list
  
  if (!apiKey) {
    console.log('⚠️ BREVO_API_KEY not set.');
    return [];
  }
  
  try {
    const apiInstance = new brevo.ContactsApi();
    apiInstance.setApiKey(brevo.ContactsApiApiKeys.apiKey, apiKey);
    
    // Get contacts from the list
    const opts = {
      limit: 500, // Max subscribers per request
      offset: 0
    };
    
    const response = await apiInstance.getContactsFromList(parseInt(listId), opts);
    const emails = response.contacts.map(contact => contact.email);
    
    console.log(`📋 Loaded ${emails.length} OSRS subscribers from Brevo list ${listId}`);
    return emails;
  } catch (error) {
    console.error('❌ Failed to load subscribers from Brevo:', error.message);
    if (error.response) {
      console.error('Response data:', error.response.body);
      console.error('Status code:', error.response.statusCode);
    }
    console.log('\n💡 TIP: List ID 4 may not exist. Falling back to test mode.');
    console.log('    Add your email below or create list ID 4 in Brevo dashboard.');
    
    // TEMPORARY: Return a test email for development
    // Replace with your email or remove this once you fix the list ID
    return ['laserwolve@gmail.com']; // TODO: Replace with your actual email or fix list ID
  }
}

/**
 * Sends newsletter via Brevo
 * @param {Array} subscribers - Array of subscriber emails
 */
async function sendNewsletter(subscribers) {
  const apiKey = process.env.BREVO_API_KEY;
  
  if (!apiKey) {
    console.log('⚠️ BREVO_API_KEY not set. Skipping newsletter.');
    return;
  }
  
  if (subscribers.length === 0) {
    console.log('📭 No OSRS subscribers found. Skipping newsletter.');
    return;
  }
  
  try {
    // Configure Brevo API
    const apiInstance = new brevo.TransactionalEmailsApi();
    apiInstance.setApiKey(brevo.TransactionalEmailsApiApiKeys.apiKey, apiKey);
    
    // Read the HTML report
    const htmlContent = fs.readFileSync('docs/osrs/index.html', 'utf8');
    
    const currentDate = new Date().toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
    
    const subject = `Old School RuneScape Market Analysis - ${currentDate}`;
    
    // Prepare email
    const sendSmtpEmail = new brevo.SendSmtpEmail();
    sendSmtpEmail.subject = subject;
    sendSmtpEmail.htmlContent = htmlContent;
    sendSmtpEmail.sender = {
      name: 'Mythic Market Mogul',
      email: 'reports@vineyardtechnologies.org'
    };
    sendSmtpEmail.to = subscribers.map(email => ({ email }));
    sendSmtpEmail.replyTo = {
      email: 'reports@vineyardtechnologies.org',
      name: 'Mythic Market Mogul'
    };
    
    console.log(`\n📧 Sending OSRS newsletter to ${subscribers.length} subscriber(s)...`);
    console.log(`Recipients: ${subscribers.join(', ')}`);
    console.log(`Subject: ${subject}`);
    
    const response = await apiInstance.sendTransacEmail(sendSmtpEmail);
    console.log(`✅ Newsletter sent successfully!`);
    console.log(`Message ID: ${response.messageId}`);
    console.log(`Full response:`, JSON.stringify(response, null, 2));
  } catch (error) {
    console.error(`❌ Failed to send newsletter:`, error.message);
    if (error.response) {
      console.error('Error response body:', error.response.body);
      console.error('Error status code:', error.response.statusCode);
    }
    console.error('Full error:', error);
    // Don't throw - newsletter failure shouldn't break the analysis
  }
}

// ===== GITHUB ACTIONS RUNNER =====

/**
 * Main entry point when run directly (e.g., node osrs.js or GitHub Actions)
 */
async function main() {
  const IS_GITHUB_ACTIONS = process.env.GITHUB_ACTIONS === 'true';

  console.log('🚀 OSRS GitHub Actions Analysis');
  console.log('===============================');
  console.log(`Environment: ${IS_GITHUB_ACTIONS ? 'GitHub Actions' : 'Local'}`);
  console.log('');

  const startTime = Date.now();
  
  try {
    const results = await runOSRSAutomated({
      isGitHubActions: IS_GITHUB_ACTIONS,
      logFile: 'osrs-analysis.log'
    });
    
    const endTime = Date.now();
    const analysisTime = Math.round((endTime - startTime) / 1000);
    
    // Add metadata
    results.metadata = {
      itemsAnalyzed: results.totalAnalyzed || 0,
      analysisTime: `${Math.floor(analysisTime / 60)}m ${analysisTime % 60}s`,
      timestamp: new Date().toISOString(),
      environment: 'GitHub Actions'
    };
    
    // Save results to JSON
    fs.writeFileSync('osrs-results.json', JSON.stringify(results, null, 2));
    
    // Generate and update the index.html file
    const reportHtml = generateEmailReport(results);
    fs.writeFileSync('docs/osrs/index.html', reportHtml);
    
    console.log('\n✅ OSRS Analysis Complete!');
    console.log(`Total time: ${results.metadata.analysisTime}`);
    console.log(`Items analyzed: ${results.metadata.itemsAnalyzed}`);
    console.log('Results saved to osrs-results.json');
    console.log('Updated docs/osrs/index.html');
    
    // Log summary for GitHub Actions
    console.log('\n📊 RESULTS SUMMARY:');
    console.log(`High Risk Members: ${results.highRiskMembers?.length || 0} items`);
    console.log(`Low Risk Members: ${results.lowRiskMembers?.length || 0} items`);
    console.log(`High Risk F2P: ${results.highRiskF2P?.length || 0} items`);
    console.log(`Low Risk F2P: ${results.lowRiskF2P?.length || 0} items`);
    
    // Send newsletter if in GitHub Actions
    if (IS_GITHUB_ACTIONS) {
      const subscribers = await loadSubscribers();
      await sendNewsletter(subscribers);
    }
    
  } catch (error) {
    console.error('❌ OSRS Analysis failed:', error.message);
    
    // Save error info
    const errorResult = {
      error: error.message,
      metadata: {
        timestamp: new Date().toISOString(),
        environment: 'GitHub Actions',
        failed: true
      }
    };
    
    fs.writeFileSync('osrs-results.json', JSON.stringify(errorResult, null, 2));
    
    // Generate error report and update index.html
    const reportHtml = generateEmailReport(errorResult);
    fs.writeFileSync('docs/osrs/index.html', reportHtml);
    
    process.exit(1);
  }
}

// Run main function if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
