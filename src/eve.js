import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import * as brevo from '@getbrevo/brevo';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const pkg = require('../package.json');
const HISTORY_FILE = path.join(__dirname, '..', 'data', 'eve-history.json');
const ITEMS_FILE = path.join(__dirname, '..', 'data', 'eve-items.json');
const REGIONS_FILE = path.join(__dirname, '..', 'data', 'eve-regions.json');
const ETAGS_FILE = path.join(__dirname, '..', 'data', 'eve-etags.json');
const API_REQUEST_DELAY = 1000; // Milliseconds between ESI API calls
const NUMBER_OF_ITEMS_TO_PROCESS = 10000;

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
    USER_AGENT = `${pkg.name}/${pkg.version} (${getGitHubEmail()}; +${getRepoUrl()})`;
  }
  return USER_AGENT;
};

/**
 * Delays execution for a specified time
 * @param {number} ms - Milliseconds to wait
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ===== MARKET HISTORY POPULATION FUNCTIONS =====
// NOTE: Population logic has been moved to main() function

/**
 * Aggregates market history across all regions into a single dataset per item.
 * Uses volume-weighted average price, summed volumes, max high, min low.
 * @param {Object} historyData - Nested object: { regionId: { typeId: [...entries] } }
 * @returns {Object} Aggregated data: { typeId: [...merged entries] }
 */
function aggregateRegionData(historyData) {
  const byTypeAndDate = {}; // typeId -> date -> aggregation accumulators

  for (const regionId of Object.keys(historyData)) {
    const regionData = historyData[regionId];
    for (const typeId of Object.keys(regionData)) {
      if (!byTypeAndDate[typeId]) {
        byTypeAndDate[typeId] = {};
      }
      for (const entry of regionData[typeId]) {
        const date = entry.date;
        if (!byTypeAndDate[typeId][date]) {
          byTypeAndDate[typeId][date] = {
            date,
            totalVolume: 0,
            weightedAvgSum: 0,
            highest: -Infinity,
            lowest: Infinity,
            orderCount: 0
          };
        }
        const agg = byTypeAndDate[typeId][date];
        agg.totalVolume += entry.volume;
        agg.weightedAvgSum += entry.average * entry.volume;
        agg.highest = Math.max(agg.highest, entry.highest);
        agg.lowest = Math.min(agg.lowest, entry.lowest);
        agg.orderCount += entry.order_count;
      }
    }
  }

  // Convert accumulators to flat arrays sorted by date
  const result = {};
  for (const typeId of Object.keys(byTypeAndDate)) {
    const dates = Object.keys(byTypeAndDate[typeId]).sort();
    result[typeId] = dates.map(date => {
      const agg = byTypeAndDate[typeId][date];
      return {
        date: agg.date,
        average: agg.totalVolume > 0 ? agg.weightedAvgSum / agg.totalVolume : 0,
        highest: agg.highest,
        lowest: agg.lowest,
        volume: agg.totalVolume,
        order_count: agg.orderCount
      };
    });
  }

  return result;
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
 * Automated EVE analysis for GitHub Actions
 * @param {Object} options - Configuration options
 * @param {string} options.logFile - Path to log file
 * @returns {Promise<Object>} Analysis results
 */
export async function runEVEAutomated(options = {}) {
  const { logFile = null } = options;
  
  const logMessage = (message) => {
    console.log(message);
    if (logFile) {
      const timestamp = new Date().toISOString();
      require('fs').appendFileSync(logFile, `${timestamp}: ${message}\n`);
    }
  };

  logMessage('🚀 EVE Online Investment Analyzer');
  logMessage('===================================');
  
  logMessage(`Analyzing items from history data`);
  logMessage('');

  // Load history data (nested: regionId -> typeId -> entries)
  let rawHistoryData = null;
  try {
    const historyContent = await fs.promises.readFile(HISTORY_FILE, 'utf-8');
    rawHistoryData = JSON.parse(historyContent);
    const regionCount = Object.keys(rawHistoryData).length;
    logMessage(`✅ Loaded history across ${regionCount} regions`);
  } catch (error) {
    throw new Error(`Could not load history data: ${error.message}`);
  }

  // Aggregate across regions for analysis
  logMessage('Aggregating data across all regions...');
  const historyData = aggregateRegionData(rawHistoryData);
  logMessage(`✅ Aggregated data for ${Object.keys(historyData).length} unique items`);

  // Load item names from eve-items.json
  let itemsData = null;
  try {
    const itemsContent = await fs.promises.readFile(ITEMS_FILE, 'utf-8');
    itemsData = JSON.parse(itemsContent);
    logMessage(`✅ Loaded ${Object.keys(itemsData).length} item names`);
  } catch (error) {
    throw new Error(`Could not load items data: ${error.message}`);
  }

  // Create a reverse lookup map (typeId -> name)
  const typeIdToName = {};
  for (const [name, typeId] of Object.entries(itemsData)) {
    typeIdToName[typeId] = name;
  }

  logMessage('');

  const results = [];
  let itemsChecked = 0;
  let successfulAnalyses = 0;

  // Analyze all items in history data
  const typeIds = Object.keys(historyData);
  
  for (let i = 0; i < typeIds.length; i++) {
    const typeId = typeIds[i];
    const history = historyData[typeId];
    itemsChecked++;
    
    // Progress update every 100 items
    if (itemsChecked % 100 === 0 || itemsChecked === typeIds.length) {
      logMessage(`Progress: ${itemsChecked}/${typeIds.length} (${successfulAnalyses} analyzed)`);
    }
    
    if (history && history.length > 0) {
      const itemInfo = {
        id: parseInt(typeId),
        name: typeIdToName[typeId] || `Item ${typeId}`
      };
      
      const analysis = analyzeItem(history, itemInfo);
      
      if (analysis) {
        results.push(analysis);
        successfulAnalyses++;
      }
    }
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
 * Main entry point for GitHub Actions workflow
 */
async function main() {
  console.log('🚀 EVE Online Market Analyzer');
  console.log('==============================');
  console.log('Running in GitHub Actions');
  console.log('');

  const startTime = Date.now();
  
  try {
    // STEP 1: Populate eve-history.json by fetching from ESI API
    console.log('📊 Step 1: Populating market history from ESI API...');
    console.log('');
    
    // Load items from eve-items.json
    const itemsFilePath = path.join(__dirname, '..', 'data', 'eve-items.json');
    const itemsData = JSON.parse(await fs.promises.readFile(itemsFilePath, 'utf-8'));
    const itemNames = Object.keys(itemsData);
    const totalItems = itemNames.length;
    
    // Load regions from eve-regions.json
    const regionsData = JSON.parse(await fs.promises.readFile(REGIONS_FILE, 'utf-8'));
    const regionNames = Object.keys(regionsData);
    const totalRegions = regionNames.length;
    const totalRequests = totalRegions * totalItems;
    
    console.log(`Found ${totalItems} items across ${totalRegions} regions (${totalRequests.toLocaleString()} total requests)`);
    console.log('');
    
    // Load existing history if available
    // Structure: { regionId: { typeId: [...entries] } }
    let historyData = {};
    try {
      const existingData = await fs.promises.readFile(HISTORY_FILE, 'utf-8');
      historyData = JSON.parse(existingData);
      const existingRegions = Object.keys(historyData).length;
      console.log(`Loaded existing history for ${existingRegions} regions`);
    } catch (error) {
      console.log('No existing history file found, starting fresh');
    }
    
    // Load cached ETags for conditional requests
    // Structure: { regionId: { typeId: { etag: "...", lastModified: "..." } } }
    let etagData = {};
    try {
      const existingEtags = await fs.promises.readFile(ETAGS_FILE, 'utf-8');
      etagData = JSON.parse(existingEtags);
      console.log('Loaded cached ETags for conditional requests');
    } catch (error) {
      console.log('No cached ETags found, all requests will be full fetches');
    }
    
    // Fetch history for each region and item
    let fetched = 0;
    let skipped = 0;
    let errors = 0;
    let requestCount = 0;
    
    for (let r = 0; r < totalRegions; r++) {
      // Stop if we've hit the processing limit
      if (requestCount >= NUMBER_OF_ITEMS_TO_PROCESS) break;
      
      const regionName = regionNames[r];
      const regionId = regionsData[regionName];
      
      console.log(`\n🌍 Region ${r + 1}/${totalRegions}: ${regionName} (${regionId})`);
      
      // Initialize region objects if they don't exist
      if (!historyData[regionId]) {
        historyData[regionId] = {};
      }
      if (!etagData[regionId]) {
        etagData[regionId] = {};
      }
      
      for (let i = 0; i < totalItems; i++) {
        // Stop if we've hit the processing limit
        if (requestCount >= NUMBER_OF_ITEMS_TO_PROCESS) break;
        
        const itemName = itemNames[i];
        const typeId = itemsData[itemName];
        requestCount++;
        
        // Progress update every 500 requests
        if (requestCount % 500 === 0) {
          console.log(`  Progress: ${requestCount.toLocaleString()}/${totalRequests.toLocaleString()} (${fetched} fetched, ${skipped} unchanged, ${errors} errors)`);
        }
        
        // Fetch market history from ESI API
        const url = `https://esi.evetech.net/latest/markets/${regionId}/history/?datasource=tranquility&type_id=${typeId}`;
        
        // Build headers with conditional request support
        const headers = {
          'Accept': 'application/json',
          'User-Agent': getUserAgent(),
          'X-Compatibility-Date': '2025-12-16'
        };
        
        // Add ETag/Last-Modified from previous fetch if available
        const cached = etagData[regionId]?.[typeId];
        if (cached?.etag) {
          headers['If-None-Match'] = cached.etag;
        }
        if (cached?.lastModified) {
          headers['If-Modified-Since'] = cached.lastModified;
        }
        
        try {
          const response = await fetch(url, { headers });
          
          if (response.status === 304) {
            // Data hasn't changed since last fetch, keep existing data
            skipped++;
            continue;
          } else if (response.ok) {
            const history = await response.json();
            historyData[regionId][typeId] = history;
            fetched++;
            
            // Cache the ETag and Last-Modified for next run
            const etag = response.headers.get('etag');
            const lastModified = response.headers.get('last-modified');
            if (etag || lastModified) {
              etagData[regionId][typeId] = {
                ...(etag && { etag }),
                ...(lastModified && { lastModified })
              };
            }
          } else if (response.status === 404) {
            // Item not marketable in this region, skip
            continue;
          } else {
            console.error(`  Error fetching ${itemName} (${typeId}) in ${regionName}: HTTP ${response.status}`);
            errors++;
          }
        } catch (error) {
          console.error(`  Error fetching ${itemName} (${typeId}) in ${regionName}: ${error.message}`);
          errors++;
        }
        
        // Delay between API calls
        await delay(API_REQUEST_DELAY);
      }
    }
    
    // Save the populated history and ETags
    await fs.promises.writeFile(HISTORY_FILE, JSON.stringify(historyData, null, 2));
    await fs.promises.writeFile(ETAGS_FILE, JSON.stringify(etagData, null, 2));
    console.log('');
    console.log(`✅ Populated history: ${fetched} fetched, ${skipped} unchanged (304), ${errors} errors across ${totalRegions} regions`);
    console.log(`Saved to ${HISTORY_FILE}`);
    console.log('');
    
    // STEP 2: Run analysis using the populated data
    console.log('📊 Step 2: Analyzing market data...');
    console.log('');
    
    const results = await runEVEAutomated({
      logFile: 'eve-analysis.log'
    });
    
    const endTime = Date.now();
    const analysisTime = Math.round((endTime - startTime) / 1000);
    
    // Add metadata
    results.metadata = {
      itemsAnalyzed: results.totalAnalyzed || 0,
      itemsFetched: fetched,
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
    console.log(`Items fetched: ${fetched}`);
    console.log(`Items analyzed: ${results.metadata.itemsAnalyzed}`);
    console.log('Results saved to eve-results.json');
    console.log('Updated docs/eve/index.html');
    
    // Log summary for GitHub Actions
    console.log('\n📊 RESULTS SUMMARY:');
    console.log(`High Risk: ${results.highRisk?.length || 0} items`);
    console.log(`Low Risk: ${results.lowRisk?.length || 0} items`);
    
    // Send newsletter
    const subscribers = await loadSubscribers();
    await sendNewsletter(subscribers);
    
  } catch (error) {
    console.error('❌ Analysis failed:', error.message);
    console.error(error.stack);
    
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