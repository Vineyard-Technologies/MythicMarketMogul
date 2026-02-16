/**
 * EVE Online Investment Analyzer
 * Analyzes EVE Online market data in Jita to find profitable investment opportunities
 */

import fs from 'fs';
import { createRequire } from 'module';
import yaml from 'js-yaml';
import path from 'path';
import { fileURLToPath } from 'url';
import * as brevo from '@getbrevo/brevo';

// Get directory name for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load package.json for app name and version
const require = createRequire(import.meta.url);
const pkg = require('../package.json');

// EVE Online constants
const JITA_REGION_ID = 10000002; // The Forge (Jita)

// Currently 51,135 items in EVE. 19,118 are tradeable (have marketGroupID).
// We can get a full list of all items from https://esi.evetech.net/universe/types,
// but it doesn't include info like their name and if they're marketable or not.
// We'd have to call https://esi.evetech.net/universe/types/{type_id} on all 50,000+
// items. It's better to use the static download: https://developers.eveonline.com/static-data

// sde:
//   buildNumber: 3077380
//   releaseDate: '2025-10-28T11:14:15Z'

/**
 * Loads tradeable items from EVE Online Static Data Export (SDE)
 * @returns {Array} Array of tradeable items with id and name
 */
function loadTradeableItemsFromSDE() {
  const typesFilePath = path.join(__dirname, '..', 'data', 'types.yaml');
  
  if (!fs.existsSync(typesFilePath)) {
    throw new Error(`types.yaml not found at ${typesFilePath}. Please run eveDataCleaner.js first.`);
  }
  
  console.log('📊 Loading tradeable items from EVE SDE...');
  const typesData = yaml.load(fs.readFileSync(typesFilePath, 'utf8'));
  
  const tradeableItems = [];
  
  for (const [typeId, typeData] of Object.entries(typesData)) {
    // The cleaned data already has only tradeable items
    // Just extract the name (which is already in English)
    const itemName = typeData.name || `Item ${typeId}`;
    
    tradeableItems.push({
      id: parseInt(typeId),
      name: itemName
    });
  }
  
  console.log(`✅ Loaded ${tradeableItems.length} tradeable items from SDE`);
  return tradeableItems;
}

// Load all tradeable items from SDE
const TRADEABLE_ITEMS = loadTradeableItemsFromSDE();

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

// USER_AGENT will be constructed when needed
let USER_AGENT = null;

const getUserAgent = () => {
  if (!USER_AGENT) {
    try {
      USER_AGENT = `${pkg.name}/${pkg.version} (${getGitHubEmail()}; +${getRepoUrl()})`;
    } catch (error) {
      // Fallback for local development
      USER_AGENT = `${pkg.name}/${pkg.version} (local-development)`;
    }
  }
  return USER_AGENT;
};

// ===== API FUNCTIONS =====

/**
 * Fetches market history for an item in a specific region
 * @param {number} regionId - EVE region ID
 * @param {number} typeId - Item type ID
 * @returns {Promise<Array>} Market history data
 */
async function fetchMarketHistory(regionId, typeId) {
  const url = `https://esi.evetech.net/latest/markets/${regionId}/history/?datasource=tranquility&type_id=${typeId}`;
  
  try {
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': getUserAgent(),
        'X-Compatibility-Date': '2025-09-30'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch market data: ${response.status}`);
    }
    
    const data = await response.json();
    return data;
  } catch (error) {
    console.error(`Error fetching market data for region ${regionId}:`, error.message);
    return null;
  }
}

/**
 * Delays execution for a specified time
 * @param {number} ms - Milliseconds to wait
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ===== ANALYSIS FUNCTIONS =====

/**
 * Calculates the percentage change in price over the period
 * @param {Array} history - Array of market data points
 * @returns {number} Percentage change
 */
function calculatePriceChange(history) {
  if (history.length < 2) return 0;
  
  const firstPrice = history[0].average;
  const lastPrice = history[history.length - 1].average;
  
  return ((lastPrice - firstPrice) / firstPrice) * 100;
}

/**
 * Calculates price volatility (standard deviation)
 * @param {Array} history - Array of market data points
 * @returns {number} Volatility as percentage of mean
 */
function calculateVolatility(history) {
  if (history.length < 2) return 0;
  
  const prices = history.map(day => day.average);
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  
  const squaredDiffs = prices.map(price => Math.pow(price - mean, 2));
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / prices.length;
  const stdDev = Math.sqrt(variance);
  
  return (stdDev / mean) * 100;
}

/**
 * Calculates recent momentum (30-day vs 60-day average)
 * @param {Array} history - Array of market data points
 * @returns {number} Momentum score
 */
function calculateMomentum(history) {
  if (history.length < 60) return 0;
  
  const recent30 = history.slice(-30);
  const previous30 = history.slice(-60, -30);
  
  const recent30Avg = recent30.reduce((sum, day) => sum + day.average, 0) / recent30.length;
  const previous30Avg = previous30.reduce((sum, day) => sum + day.average, 0) / previous30.length;
  
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
  // Strategy: High-volatility items with positive momentum
  let score = 50; // Base score
  
  // High volatility is GOOD for speculation (up to +30 points)
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
  if (volume >= 10000) return 'Very High';
  if (volume >= 1000) return 'High';
  if (volume >= 100) return 'Medium';
  if (volume >= 10) return 'Low';
  return 'Very Low';
}

/**
 * Formats ISK amount with appropriate suffix
 * @param {number} amount - ISK amount
 * @returns {string} Formatted string
 */
function formatISK(amount) {
  if (amount >= 1000000000) {
    return `${(amount / 1000000000).toFixed(1)}B ISK`;
  } else if (amount >= 1000000) {
    return `${(amount / 1000000).toFixed(1)}M ISK`;
  } else if (amount >= 1000) {
    return `${(amount / 1000).toFixed(1)}K ISK`;
  }
  return `${Math.round(amount).toLocaleString()} ISK`;
}

/**
 * Analyzes market data for an item
 * @param {Array} history - Market history data
 * @param {Object} itemInfo - Item name and ID
 * @returns {Object} Analysis results
 */
function analyzeItem(history, itemInfo) {
  if (!history || history.length === 0) {
    return null;
  }
  
  // Sort by date
  history.sort((a, b) => new Date(a.date) - new Date(b.date));
  
  const priceChange = calculatePriceChange(history);
  const volatility = calculateVolatility(history);
  const momentum = calculateMomentum(history);
  
  const currentPrice = history[history.length - 1].average;
  const currentVolume = history[history.length - 1].volume;
  
  const investmentScore = calculateInvestmentScore(priceChange, volatility, momentum);
  
  // Determine risk level based on volatility
  // High risk: volatility >= 15%
  // Low risk: volatility < 15%
  const riskLevel = parseFloat(volatility) >= 15 ? 'high' : 'low';
  
  return {
    id: itemInfo.id,
    name: itemInfo.name,
    currentPrice: Math.round(currentPrice),
    priceChange: priceChange.toFixed(2),
    volatility: volatility.toFixed(2),
    momentum: momentum.toFixed(2),
    volume: currentVolume,
    volumeCategory: categorizeVolume(currentVolume || 0),
    investmentScore: investmentScore.toFixed(1),
    dataPoints: history.length,
    riskLevel: riskLevel
  };
}

// ===== MAIN APPLICATION =====

/**
 * Automated EVE analysis
 * @param {Object} options - Configuration options
 * @returns {Promise<Object>} Analysis results
 */
export async function runEVEAutomated(options = {}) {
  const { isGitHubActions = false, logFile = null } = options;
  
  const logMessage = (message) => {
    console.log(message);
    if (logFile) {
      const timestamp = new Date().toISOString();
      require('fs').appendFileSync(logFile, `${timestamp}: ${message}\n`);
    }
  };

  logMessage('🚀 EVE Online Investment Analyzer (Automated)');
  logMessage('============================================');
  
  logMessage(`Analyzing ALL available items`);
  logMessage(`Mode: ${isGitHubActions ? 'GitHub Actions' : 'Local'}`);
  logMessage('');

  // Items are already loaded from SDE at module level
  logMessage(`✅ Using ${TRADEABLE_ITEMS.length} tradeable items for analysis`);

  // Analyze ALL items (no limit)
  const shuffledItems = [...TRADEABLE_ITEMS].sort(() => Math.random() - 0.5);
  const itemsToAnalyze = shuffledItems;

  logMessage(`Analyzing ALL ${itemsToAnalyze.length} items...`);
  logMessage('');

  const results = [];
  let itemsChecked = 0;
  let successfulAnalyses = 0;

  for (let i = 0; i < itemsToAnalyze.length; i++) {
    const item = itemsToAnalyze[i];
    itemsChecked++;
    
    // Progress update every 100 items
    if (itemsChecked % 100 === 0 || itemsChecked === itemsToAnalyze.length) {
      logMessage(`Progress: ${itemsChecked}/${itemsToAnalyze.length} (${successfulAnalyses} analyzed)`);
    }
    
    const history = await fetchMarketHistory(JITA_REGION_ID, item.id);
    
    if (history && history.length > 0) {
      const analysis = analyzeItem(history, item);
      
      if (analysis) {
        results.push(analysis);
        successfulAnalyses++;
      }
    }
    
    // Rate limiting
    await delay(1000);
  }

  logMessage('');
  logMessage(`✅ EVE Analysis Complete! Analyzed ${successfulAnalyses} items`);

  // Categorize results into 2 groups (no members in EVE)
  const highRisk = results.filter(r => r.riskLevel === 'high')
    .sort((a, b) => parseFloat(b.investmentScore) - parseFloat(a.investmentScore))
    .slice(0, 5);
  
  const lowRisk = results.filter(r => r.riskLevel === 'low')
    .sort((a, b) => parseFloat(b.investmentScore) - parseFloat(a.investmentScore))
    .slice(0, 5);

  return {
    highRisk,
    lowRisk,
    totalAnalyzed: successfulAnalyses,
    totalChecked: itemsChecked
  };
}

// ===== EMAIL REPORT GENERATION =====

/**
 * Generates HTML email report from EVE analysis results
 * @param {Object} eveData - EVE analysis results
 * @returns {string} HTML email report
 */
function generateEmailReport(eveData) {
  const currentDate = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  let contentHtml = '';
  
  if (eveData.error) {
    contentHtml = `
      <div class="error">
        <p><strong>❌ Analysis Failed:</strong> ${eveData.error}</p>
      </div>
    `;
  } else {
    const { highRisk = [], lowRisk = [], metadata = {} } = eveData;
    
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
                    <img src="https://images.evetech.net/types/${item.id}/icon" alt="${item.name}">
                  </td>
                  <td class="grid-item-content" style="vertical-align: top;">
                    <h4><a href="https://evemarketbrowser.com/region/0/type/${item.id}" target="_blank">${item.name}</a></h4>
                    <div class="item-metrics">
                      <span>Price: ${formatISK(item.currentPrice)}</span>
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
            <h3>High Risk</h3>
            <table class="grid-items">
              <tr>
                <td style="width: 50%; vertical-align: top;">
${generateItemsHtml(highRisk.slice(0, 2), 'high-risk-col1')}
                </td>
                <td style="width: 50%; vertical-align: top;">
${generateItemsHtml(highRisk.slice(2, 4), 'high-risk-col2')}
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td class="grid-section">
            <h3>Low Risk</h3>
            <table class="grid-items">
              <tr>
                <td style="width: 50%; vertical-align: top;">
${generateItemsHtml(lowRisk.slice(0, 2), 'low-risk-col1')}
                </td>
                <td style="width: 50%; vertical-align: top;">
${generateItemsHtml(lowRisk.slice(2, 4), 'low-risk-col2')}
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    `;
  }

  // Read existing index.html and update only the dynamic content
  let template = fs.readFileSync('docs/eve/index.html', 'utf8');
  
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
 * Loads EVE subscriber list from Brevo contact list
 * @returns {Promise<Array>} Array of subscriber email addresses
 */
async function loadSubscribers() {
  const apiKey = process.env.BREVO_API_KEY;
  const listId = 3; // EVE Online Newsletter list
  
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
    
    console.log(`📋 Loaded ${emails.length} EVE subscribers from Brevo list ${listId}`);
    return emails;
  } catch (error) {
    console.error('❌ Failed to load subscribers from Brevo:', error.message);
    return [];
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
    console.log('📭 No EVE subscribers found. Skipping newsletter.');
    return;
  }
  
  try {
    // Configure Brevo API
    const apiInstance = new brevo.TransactionalEmailsApi();
    apiInstance.setApiKey(brevo.TransactionalEmailsApiApiKeys.apiKey, apiKey);
    
    // Read the HTML report
    const htmlContent = fs.readFileSync('docs/eve/index.html', 'utf8');
    
    const currentDate = new Date().toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
    
    const subject = `EVE Online Market Analysis - ${currentDate}`;
    
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
    
    console.log(`\n📧 Sending EVE newsletter to ${subscribers.length} subscriber(s)...`);
    const response = await apiInstance.sendTransacEmail(sendSmtpEmail);
    console.log(`✅ Newsletter sent successfully! Message ID: ${response.messageId}`);
  } catch (error) {
    console.error(`❌ Failed to send newsletter:`, error.message);
    // Don't throw - newsletter failure shouldn't break the analysis
  }
}

// ===== GITHUB ACTIONS RUNNER =====

/**
 * Main entry point when run directly (e.g., node eve.js or GitHub Actions)
 */
async function main() {
  const IS_GITHUB_ACTIONS = process.env.GITHUB_ACTIONS === 'true';

  console.log('🚀 EVE Online GitHub Actions Analysis');
  console.log('====================================');
  console.log(`Analyzing ALL available items`);
  console.log(`Environment: ${IS_GITHUB_ACTIONS ? 'GitHub Actions' : 'Local'}`);
  console.log('');

  const startTime = Date.now();
  
  try {
    const results = await runEVEAutomated({
      isGitHubActions: IS_GITHUB_ACTIONS,
      logFile: 'eve-analysis.log'
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
    fs.writeFileSync('eve-results.json', JSON.stringify(results, null, 2));
    
    // Generate and update the index.html file
    const reportHtml = generateEmailReport(results);
    fs.writeFileSync('docs/eve/index.html', reportHtml);
    
    console.log('\n✅ Analysis Complete!');
    console.log(`Total time: ${results.metadata.analysisTime}`);
    console.log(`Items analyzed: ${results.metadata.itemsAnalyzed}`);
    console.log('Results saved to eve-results.json');
    console.log('Updated docs/eve/index.html');
    
    // Log summary for GitHub Actions
    console.log('\n📊 RESULTS SUMMARY:');
    console.log(`High Risk: ${results.highRisk?.length || 0} items`);
    console.log(`Low Risk: ${results.lowRisk?.length || 0} items`);
    
    // Send newsletter if in GitHub Actions
    if (IS_GITHUB_ACTIONS) {
      const subscribers = await loadSubscribers();
      await sendNewsletter(subscribers);
    }
    
  } catch (error) {
    console.error('❌ Analysis failed:', error.message);
    
    // Save error info
    const errorResult = {
      error: error.message,
      metadata: {
        timestamp: new Date().toISOString(),
        environment: 'GitHub Actions',
        failed: true
      }
    };
    
    fs.writeFileSync('eve-results.json', JSON.stringify(errorResult, null, 2));
    
    // Generate error report and update index.html
    const reportHtml = generateEmailReport(errorResult);
    fs.writeFileSync('docs/eve/index.html', reportHtml);
    
    process.exit(1);
  }
}

// Run main function if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
