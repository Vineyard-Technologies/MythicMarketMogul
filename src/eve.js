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
const RECOMMENDATIONS_LOG_FILE = path.join(__dirname, '..', 'data', 'eve-recommendations-log.json');
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

/**
 * Writes a large two-level nested object to a JSON file using streaming to
 * avoid exceeding Node.js's maximum string length with JSON.stringify.
 * Serializes each leaf value (e.g. a single item's history array) individually.
 * Expected structure: { outerKey: { innerKey: value, ... }, ... }
 * @param {string} filePath - Path to write the JSON file
 * @param {Object} data - The two-level nested object to serialize
 */
async function writeJsonStreaming(filePath, data) {
  const writeStream = fs.createWriteStream(filePath, { encoding: 'utf-8' });

  return new Promise((resolve, reject) => {
    writeStream.on('error', reject);
    writeStream.on('finish', resolve);

    const outerKeys = Object.keys(data);
    writeStream.write('{\n');

    for (let i = 0; i < outerKeys.length; i++) {
      const outerKey = outerKeys[i];
      const inner = data[outerKey];
      const innerKeys = Object.keys(inner);

      writeStream.write(`  ${JSON.stringify(outerKey)}: {\n`);

      for (let j = 0; j < innerKeys.length; j++) {
        const innerKey = innerKeys[j];
        const value = JSON.stringify(inner[innerKey]);
        writeStream.write(`    ${JSON.stringify(innerKey)}: ${value}`);
        if (j < innerKeys.length - 1) {
          writeStream.write(',');
        }
        writeStream.write('\n');
      }

      writeStream.write('  }');
      if (i < outerKeys.length - 1) {
        writeStream.write(',');
      }
      writeStream.write('\n');
    }

    writeStream.end('}\n');
  });
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
  
  // Calculate short-term price changes (7-day and 30-day)
  let priceChange7d = 0;
  let priceChange30d = 0;
  if (history.length >= 7) {
    const price7dAgo = history[history.length - 7].average;
    priceChange7d = price7dAgo > 0 ? ((currentPrice - price7dAgo) / price7dAgo) * 100 : 0;
  }
  if (history.length >= 30) {
    const price30dAgo = history[history.length - 30].average;
    priceChange30d = price30dAgo > 0 ? ((currentPrice - price30dAgo) / price30dAgo) * 100 : 0;
  }
  
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
    priceChange7d: priceChange7d.toFixed(2),
    priceChange30d: priceChange30d.toFixed(2),
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

  // Compute market-wide overview stats
  const allMomentums = results.map(r => parseFloat(r.momentum));
  const avgMomentum = allMomentums.length > 0
    ? (allMomentums.reduce((a, b) => a + b, 0) / allMomentums.length).toFixed(2)
    : '0.00';
  const itemsUp = results.filter(r => parseFloat(r.momentum) > 0).length;
  const itemsDown = results.filter(r => parseFloat(r.momentum) < 0).length;
  const itemsFlat = results.filter(r => parseFloat(r.momentum) === 0).length;
  const allVolatilities = results.map(r => parseFloat(r.volatility));
  const avgVolatility = allVolatilities.length > 0
    ? (allVolatilities.reduce((a, b) => a + b, 0) / allVolatilities.length).toFixed(2)
    : '0.00';

  const marketOverview = {
    totalItems: results.length,
    avgMomentum,
    avgVolatility,
    itemsUp,
    itemsDown,
    itemsFlat
  };

  // Find notable movers (biggest gainers and losers by 7-day price change)
  const sortedByChange = [...results]
    .filter(r => parseFloat(r.priceChange7d) !== 0)
    .sort((a, b) => parseFloat(b.priceChange7d) - parseFloat(a.priceChange7d));
  
  const notableMovers = {
    biggestGainers: sortedByChange.slice(0, 3).map(r => ({
      name: r.name,
      priceChange7d: r.priceChange7d,
      currentPrice: r.currentPrice,
      volumeCategory: r.volumeCategory
    })),
    biggestLosers: sortedByChange.slice(-3).reverse().map(r => ({
      name: r.name,
      priceChange7d: r.priceChange7d,
      currentPrice: r.currentPrice,
      volumeCategory: r.volumeCategory
    }))
  };

  return {
    highRisk,
    lowRisk,
    marketOverview,
    notableMovers,
    totalAnalyzed: successfulAnalyses,
    totalChecked: itemsChecked
  };
}

// ===== AI OPINION GENERATION =====

/**
 * Generates an AI-written opinion piece using GitHub Models API.
 * Uses the GITHUB_TOKEN that is automatically available in GitHub Actions.
 * Falls back to a default opinion if the API call fails.
 * @param {Object} analysisData - The analysis results with highRisk and lowRisk arrays
 * @returns {Promise<Object>} Object with { introParagraph, detailParagraph } as plain text
 */
async function generateOpinion(analysisData, previousResults = null) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.log('⚠️ GITHUB_TOKEN not set. Using default opinion.');
    return getDefaultOpinion(analysisData);
  }

  const { highRisk = [], lowRisk = [], marketOverview = {}, notableMovers = {} } = analysisData;

  // Build a summary of the recommended items with price history
  const highRiskSummary = highRisk.map(item =>
    `- ${item.name}: ${formatISK(item.currentPrice)}, Volume: ${item.volumeCategory}, Volatility: ${item.volatility}%, Momentum: ${item.momentum > 0 ? '+' : ''}${item.momentum}%, 7d change: ${item.priceChange7d > 0 ? '+' : ''}${item.priceChange7d}%, 30d change: ${item.priceChange30d > 0 ? '+' : ''}${item.priceChange30d}%`
  ).join('\n');

  const lowRiskSummary = lowRisk.map(item =>
    `- ${item.name}: ${formatISK(item.currentPrice)}, Volume: ${item.volumeCategory}, Volatility: ${item.volatility}%, Momentum: ${item.momentum > 0 ? '+' : ''}${item.momentum}%, 7d change: ${item.priceChange7d > 0 ? '+' : ''}${item.priceChange7d}%, 30d change: ${item.priceChange30d > 0 ? '+' : ''}${item.priceChange30d}%`
  ).join('\n');

  // Market-wide trends
  const marketOverviewText = marketOverview.totalItems
    ? `\n\nMARKET-WIDE TRENDS:\n- ${marketOverview.totalItems} items tracked\n- Average momentum across all items: ${marketOverview.avgMomentum}%\n- Average volatility across all items: ${marketOverview.avgVolatility}%\n- Items trending up: ${marketOverview.itemsUp} | down: ${marketOverview.itemsDown} | flat: ${marketOverview.itemsFlat}`
    : '';

  // Notable movers
  let moversText = '';
  if (notableMovers.biggestGainers?.length > 0 || notableMovers.biggestLosers?.length > 0) {
    moversText = '\n\nNOTABLE MOVERS (7-day):';
    if (notableMovers.biggestGainers?.length > 0) {
      moversText += '\nBiggest Gainers:';
      for (const g of notableMovers.biggestGainers) {
        moversText += `\n- ${g.name}: ${g.priceChange7d > 0 ? '+' : ''}${g.priceChange7d}% (${formatISK(g.currentPrice)}, Volume: ${g.volumeCategory})`;
      }
    }
    if (notableMovers.biggestLosers?.length > 0) {
      moversText += '\nBiggest Losers:';
      for (const l of notableMovers.biggestLosers) {
        moversText += `\n- ${l.name}: ${l.priceChange7d > 0 ? '+' : ''}${l.priceChange7d}% (${formatISK(l.currentPrice)}, Volume: ${l.volumeCategory})`;
      }
    }
  }

  // Historical comparison with yesterday's picks
  let comparisonText = '';
  if (previousResults && !previousResults.error) {
    const prevHighNames = (previousResults.highRisk || []).map(i => i.name);
    const prevLowNames = (previousResults.lowRisk || []).map(i => i.name);
    const currHighNames = highRisk.map(i => i.name);
    const currLowNames = lowRisk.map(i => i.name);

    const newHighRisk = currHighNames.filter(n => !prevHighNames.includes(n));
    const droppedHighRisk = prevHighNames.filter(n => !currHighNames.includes(n));
    const newLowRisk = currLowNames.filter(n => !prevLowNames.includes(n));
    const droppedLowRisk = prevLowNames.filter(n => !currLowNames.includes(n));

    if (newHighRisk.length > 0 || droppedHighRisk.length > 0 || newLowRisk.length > 0 || droppedLowRisk.length > 0) {
      comparisonText = '\n\nCHANGES FROM YESTERDAY:';
      if (newHighRisk.length > 0) comparisonText += `\n- New high-risk picks: ${newHighRisk.join(', ')}`;
      if (droppedHighRisk.length > 0) comparisonText += `\n- Dropped from high-risk: ${droppedHighRisk.join(', ')}`;
      if (newLowRisk.length > 0) comparisonText += `\n- New low-risk picks: ${newLowRisk.join(', ')}`;
      if (droppedLowRisk.length > 0) comparisonText += `\n- Dropped from low-risk: ${droppedLowRisk.join(', ')}`;
    } else {
      comparisonText = '\n\nCHANGES FROM YESTERDAY:\n- Same picks as yesterday — no changes to the lineup.';
    }
  }

  // Load recent AI analyses from the recommendations log to avoid repetition
  let recentAnalysesText = '';
  try {
    const logContent = fs.readFileSync(RECOMMENDATIONS_LOG_FILE, 'utf-8');
    const log = JSON.parse(logContent);
    const recentEntries = log
      .filter(entry => entry.aiAnalysis && entry.aiAnalysis.introParagraph)
      .slice(-3); // Last 3 entries
    if (recentEntries.length > 0) {
      recentAnalysesText = '\n\nYOUR RECENT OPINION PIECES (do NOT repeat these — write something fresh and different):';
      for (const entry of recentEntries) {
        const entryDate = new Date(entry.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        recentAnalysesText += `\n\n[${entryDate}]:\n${entry.aiAnalysis.introParagraph}\n${entry.aiAnalysis.detailParagraph}`;
      }
    }
  } catch (e) {
    // No log file yet, that's fine
  }

  // Vary the writing angle each day
  const angles = [
    'Focus on what changed since yesterday and why it matters for traders.',
    'Lead with the most surprising or unusual data point you see in today\'s picks.',
    'Frame your analysis around the overall market mood — is it bullish, bearish, or uncertain?',
    'Pick one standout item and build your commentary around why it\'s the most interesting play today.',
    'Compare the risk profiles — what does the contrast between high and low risk picks tell us today?',
    'Think about what a new trader needs to hear versus what a veteran would find useful.',
    'Open with a bold prediction or hot take based on the momentum and volatility data.',
  ];
  const dayIndex = Math.floor(Date.now() / 86400000);
  const todayAngle = angles[dayIndex % angles.length];

  // Build a list of banned opening words from recent analyses to force variety
  let bannedOpenings = '';
  if (recentAnalysesText) {
    try {
      const logContent = fs.readFileSync(RECOMMENDATIONS_LOG_FILE, 'utf-8');
      const log = JSON.parse(logContent);
      const recentWords = log
        .filter(e => e.aiAnalysis?.introParagraph)
        .slice(-5)
        .flatMap(e => [
          e.aiAnalysis.introParagraph.split(/\s+/)[0],
          e.aiAnalysis.detailParagraph?.split(/\s+/)[0]
        ].filter(Boolean));
      if (recentWords.length > 0) {
        bannedOpenings = `\n- BANNED OPENING WORDS (you used these recently, pick something else): ${[...new Set(recentWords)].join(', ')}`;
      }
    } catch (_) { /* ignore */ }
  }

  // Pick a random persona variation
  const personas = [
    'Today you\'re feeling cautiously optimistic — you see opportunity but want traders to stay grounded.',
    'Today you\'re in a skeptical mood — you\'re questioning whether the numbers tell the full story.',
    'Today you\'re excited — something in the data caught your eye and you can\'t wait to share it.',
    'Today you\'re reflective — comparing today to recent trends and thinking about the bigger picture.',
    'Today you\'re giving tough-love advice — being blunt about what looks good and what doesn\'t.',
    'Today you\'re feeling playful — cracking a joke or two while still delivering solid market insight.',
    'Today you\'re in teacher mode — explaining why the numbers matter, not just what they are.',
  ];
  const todayPersona = personas[(dayIndex + 2) % personas.length];

  // Pick a random structural format
  const formats = [
    'Start your first paragraph with a question. Start your second paragraph with a bold claim.',
    'Start your first paragraph by naming the single most interesting low-risk item. Start your second paragraph with a warning.',
    'Start your first paragraph with a metaphor or analogy. Start your second paragraph with "Meanwhile" or a transition word.',
    'Start your first paragraph with a short punchy sentence (under 8 words). Then expand. Start your second paragraph by addressing the reader directly.',
    'Start your first paragraph by comparing two low-risk items. Start your second paragraph with the most dramatic number from the high-risk data.',
    'Start your first paragraph with an observation about overall market sentiment. Start your second paragraph by singling out the wildest high-risk pick.',
  ];
  const todayFormat = formats[(dayIndex + 5) % formats.length];

  const prompt = `You are Foggle Lopperbottom, a savvy EVE Online market analyst who writes daily trading opinion pieces. You have a casual but knowledgeable tone — you speak like an experienced trader sharing tips with friends. You know EVE Online lore, items, and market mechanics well.

${todayPersona}

Here are today's recommended items:

HIGH RISK (volatile, speculative):
${highRiskSummary}

LOW RISK (stable, consistent):
${lowRiskSummary}${marketOverviewText}${moversText}${comparisonText}${recentAnalysesText}

TODAY'S WRITING ANGLE: ${todayAngle}
TODAY'S STRUCTURE: ${todayFormat}

Write a short opinion piece with exactly TWO paragraphs:

1. FIRST PARAGRAPH: Commentary on the low-risk picks and/or market-wide trends. Start directly with your analysis (no date prefix, that's added separately).

2. SECOND PARAGRAPH: Commentary on the high-risk picks — highlight specific items by name.

Rules:
- Keep it concise — each paragraph should be 2-3 sentences max
- Sound natural and conversational, like you're chatting with fellow capsuleers
- Reference specific item names from the data — use at least 2 different item names per paragraph
- Use the market overview, notable movers, and changes from yesterday to add color and context where relevant — don't just repeat the numbers, interpret them
- CRITICAL: Your response must be COMPLETELY DIFFERENT from your recent pieces shown above. Do NOT reuse phrases, sentence structures, or paragraph openings. Every sentence must be freshly written.${bannedOpenings}
- Vary sentence LENGTH — mix short punchy statements with longer explanatory ones
- Include at least one specific insight that goes beyond restating numbers (e.g., what a trend implies, a risk to watch for, or a trading strategy hint)
- Do NOT use markdown formatting, just plain text
- Do NOT include any HTML tags
- Do NOT start with a date
- Separate the two paragraphs with exactly |||SPLIT||| on its own line`;

  try {
    console.log('🤖 Generating AI opinion via GitHub Models...');
    const response = await fetch('https://models.github.ai/inference/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.AI_MODEL || 'openai/gpt-4o-mini',
        messages: [
          { role: 'user', content: prompt }
        ],
        max_tokens: 500,
        temperature: 1.0
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ GitHub Models API error (HTTP ${response.status}): ${errorText}`);
      return getDefaultOpinion(analysisData);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content?.trim();

    if (!content) {
      console.error('❌ Empty response from GitHub Models API');
      return getDefaultOpinion(analysisData);
    }

    // Split into two paragraphs
    const parts = content.split('|||SPLIT|||').map(p => p.trim());
    if (parts.length >= 2) {
      console.log('✅ AI opinion generated successfully');
      return {
        introParagraph: parts[0],
        detailParagraph: parts[1]
      };
    } else {
      // Fallback: try splitting on double newline
      const fallbackParts = content.split(/\n\n+/).map(p => p.trim()).filter(p => p.length > 0);
      if (fallbackParts.length >= 2) {
        console.log('✅ AI opinion generated successfully (fallback split)');
        return {
          introParagraph: fallbackParts[0],
          detailParagraph: fallbackParts[1]
        };
      }
      console.log('✅ AI opinion generated (single block)');
      return {
        introParagraph: content,
        detailParagraph: ''
      };
    }
  } catch (error) {
    console.error(`❌ Failed to generate AI opinion: ${error.message}`);
    return getDefaultOpinion(analysisData);
  }
}

/**
 * Returns a default opinion when AI generation is unavailable.
 * Uses a large pool of templates, tones, and structures that rotate
 * based on the current date so every day reads differently.
 * @param {Object} analysisData - The analysis results
 * @returns {Object} Object with { introParagraph, detailParagraph }
 */
function getDefaultOpinion(analysisData) {
  const { highRisk = [], lowRisk = [], marketOverview = {}, notableMovers = {} } = analysisData;

  // --- helper selectors driven by day-of-year so we rotate deterministically ---
  const dayIndex = Math.floor(Date.now() / 86400000); // days since epoch
  const pick = (arr) => arr[dayIndex % arr.length];
  const pick2 = (arr) => arr[(dayIndex + 3) % arr.length]; // offset so two picks from same pool differ

  // --- extract useful data points ---
  const lowNames = lowRisk.slice(0, 3).map(i => i.name);
  const lowNamesStr = lowNames.join(', ');
  const topLow = lowRisk[0];
  const topHigh = highRisk[0];
  const secondHigh = highRisk[1];
  const lowestVol = lowRisk.length > 0
    ? lowRisk.reduce((a, b) => parseFloat(a.volatility) < parseFloat(b.volatility) ? a : b)
    : null;
  const highestMomentum = highRisk.length > 0
    ? highRisk.reduce((a, b) => parseFloat(a.momentum) > parseFloat(b.momentum) ? a : b)
    : null;
  const biggestSwing = highRisk.length > 0
    ? highRisk.reduce((a, b) => Math.abs(parseFloat(a.priceChange7d)) > Math.abs(parseFloat(b.priceChange7d)) ? a : b)
    : null;

  const fmt = (item) => formatISK(item.currentPrice);
  const sign = (v) => (parseFloat(v) > 0 ? '+' : '') + v;

  // Determine broad market sentiment from available data
  let sentiment = 'mixed';
  if (marketOverview.itemsUp > marketOverview.itemsDown * 1.3) sentiment = 'bullish';
  else if (marketOverview.itemsDown > marketOverview.itemsUp * 1.3) sentiment = 'bearish';

  // --- LOW-RISK paragraph templates ---
  const introTemplates = [
    // template 0 - spotlight lowest volatility
    () => lowestVol
      ? `${lowestVol.name} is the calmest waters in today's lineup at just ${lowestVol.volatility}% volatility — exactly the kind of stability ISK-preserving traders want. ${lowNames.length > 1 ? `${lowNames.filter(n => n !== lowestVol.name).join(' and ')} round out a solid low-risk shelf.` : ''}`
      : `Today's low-risk picks look dependable. If you're parking ISK somewhere safe, ${lowNamesStr} should let you sleep easy.`,
    // template 1 - volume focus
    () => {
      const highVolItems = lowRisk.filter(i => i.volumeCategory === 'Very High');
      return highVolItems.length > 0
        ? `Liquidity lovers, take note: ${highVolItems.slice(0, 2).map(i => i.name).join(' and ')} ${highVolItems.length > 1 ? 'are both' : 'is'} moving at Very High volume, so getting in and out should be painless. Low volatility across the board makes the stable shelf a comfortable hold today.`
        : `The stable picks today — ${lowNamesStr} — are keeping things predictable. Volume is moderate, so set your orders and be patient.`;
    },
    // template 2 - momentum snapshot
    () => topLow
      ? `Steady as she goes: ${topLow.name} at ${fmt(topLow)} is carrying ${sign(topLow.momentum)}% momentum with only ${topLow.volatility}% volatility. That's the kind of ratio conservative traders love to see. ${lowNames.length > 2 ? `${lowNames[1]} and ${lowNames[2]} are in a similar groove.` : ''}`
      : `Not a lot of fireworks on the low-risk side today, but that's the whole point. Capital preservation is the name of the game.`,
    // template 3 - comparison angle
    () => lowRisk.length >= 2
      ? `Comparing today's safe plays, ${lowRisk[0].name} (${sign(lowRisk[0].priceChange30d)}% over 30d) and ${lowRisk[1].name} (${sign(lowRisk[1].priceChange30d)}%) tell slightly different stories. One's been climbing, the other dipping — but both stay within that comfortable low-volatility band where surprises are rare.`
      : `${lowNamesStr} ${lowRisk.length === 1 ? 'stands' : 'stand'} out as today's reliable pick${lowRisk.length === 1 ? '' : 's'} for traders who prefer low drama.`,
    // template 4 - market mood
    () => {
      if (sentiment === 'bullish') return `The broader market's leaning green today, and the low-risk shelf is riding that wave. ${lowNamesStr} look like solid places to park ISK while the tide is up.`;
      if (sentiment === 'bearish') return `With the overall market pulling back, the stability of ${lowNamesStr} is worth its weight in Tritanium right now. Low volatility is a feature, not a bug, on days like this.`;
      return `Markets are sending mixed signals today, which makes the dependability of picks like ${lowNamesStr} that much more appealing. Sometimes boring is beautiful.`;
    },
    // template 5 - direct advice tone
    () => topLow
      ? `If I'm putting ISK to work today with minimal risk, ${topLow.name} at ${fmt(topLow)} is where I'd start — ${topLow.volatility}% volatility and ${topLow.volumeCategory.toLowerCase()} volume make for an easy entry. ${lowNames.length > 1 ? `${lowNames.slice(1).join(' and ')} ${lowNames.length > 2 ? 'are' : 'is'} on the shortlist too.` : ''}`
      : `The safe side of the board is thin today. Sometimes the best move is to sit tight and wait for cleaner setups.`,
    // template 6 - narrative / story
    () => lowRisk.length >= 2
      ? `There's a quiet reliability to ${lowRisk[0].name} and ${lowRisk[1].name} that seasoned traders appreciate. Neither will make you rich overnight, but they won't blow up your portfolio either — and in New Eden, that counts for a lot.`
      : `Today's conservative play is straightforward: ${lowNamesStr}. Nothing flashy, just consistent.`,
    // template 7 - data-driven
    () => {
      const avgVol = lowRisk.length > 0
        ? (lowRisk.reduce((s, i) => s + parseFloat(i.volatility), 0) / lowRisk.length).toFixed(1)
        : '0';
      return `Across the low-risk picks, average volatility sits at ${avgVol}% — that's textbook stable. ${lowNamesStr} make up a well-diversified safe basket for today's session.`;
    },
  ];

  // --- HIGH-RISK paragraph templates ---
  const detailTemplates = [
    // template 0 - spotlight top pick
    () => topHigh
      ? `${topHigh.name} at ${fmt(topHigh)} is the headliner — ${sign(topHigh.momentum)}% momentum and ${topHigh.volatility}% volatility mean big swings in either direction. ${secondHigh ? `${secondHigh.name} is another wild card worth watching.` : ''} These aren't buy-and-hold plays; timing is everything.`
      : `No standout high-risk picks today — sometimes the best trade is no trade at all.`,
    // template 1 - biggest swing
    () => biggestSwing
      ? `The biggest mover this week is ${biggestSwing.name} at ${sign(biggestSwing.priceChange7d)}% over seven days — that's the kind of action adrenaline traders live for. At ${fmt(biggestSwing)} a pop, the entry is ${parseFloat(biggestSwing.currentPrice) < 100 ? 'dirt cheap, making it easy to gamble with small stacks' : 'significant, so size your position carefully'}.`
      : `High-risk picks are quiet today. Keep your powder dry.`,
    // template 2 - momentum leader
    () => highestMomentum
      ? `Momentum chasers, your eyes should be on ${highestMomentum.name} — ${sign(highestMomentum.momentum)}% and climbing. Pair that with ${highestMomentum.volatility}% volatility and you've got a recipe for either a quick win or a hard lesson. ${highRisk.length > 2 ? `The rest of the speculative shelf (${highRisk.slice(1, 3).map(i => i.name).join(', ')}) is equally spicy.` : ''}`
      : `Nothing on the high-risk side is screaming momentum right now. Patience pays.`,
    // template 3 - risk warning tone
    () => topHigh
      ? `Fair warning: the speculative picks today are not for the faint of heart. ${topHigh.name} is sitting at ${topHigh.volatility}% volatility, and ${secondHigh ? `${secondHigh.name} isn't much calmer at ${secondHigh.volatility}%` : 'the rest of the lineup is similarly wild'}. If you're going in, set your stop-losses and stick to them.`
      : `The high-risk board is empty today — the market isn't offering any clear speculative plays worth chasing.`,
    // template 4 - cheap vs expensive
    () => {
      const cheap = highRisk.filter(i => i.currentPrice < 50);
      const pricey = highRisk.filter(i => i.currentPrice >= 50);
      if (cheap.length > 0 && pricey.length > 0) {
        return `Today's speculative shelf has something for every budget: ${cheap.map(i => i.name).join(', ')} ${cheap.length > 1 ? 'are' : 'is'} cheap enough to throw pocket change at, while ${pricey[0].name} at ${fmt(pricey[0])} demands more commitment. All of them are volatile — that's the price of admission.`;
      }
      return topHigh
        ? `On the wild side, ${topHigh.name} leads the speculative picks at ${fmt(topHigh)}. With ${topHigh.volatility}% volatility, it's a coin flip that could land in your favor if the momentum holds.`
        : `No standout high-risk picks today. The market needs a catalyst.`;
    },
    // template 5 - day-over-day change focus
    () => topHigh
      ? `${topHigh.name} just moved ${sign(topHigh.priceChange)}% since yesterday — that tells you everything about the kind of day the speculative side is having. ${highRisk.length > 1 ? `Meanwhile, ${highRisk[highRisk.length - 1].name} is simmering at ${sign(highRisk[highRisk.length - 1].priceChange)}%, waiting to boil over.` : ''} High risk, high reward — the mantra never changes.`
      : `Nothing's popping on the high-risk radar today. Check back tomorrow.`,
    // template 6 - lore-flavored
    () => topHigh
      ? `Every capsuleer knows the rush of a good gamble, and today ${topHigh.name} at ${fmt(topHigh)} is calling from the speculative fringe. ${topHigh.volatility}% volatility is not for the risk-averse. ${secondHigh ? `If that's too tame, ${secondHigh.name} is even wilder at ${secondHigh.volatility}% vol.` : ''}`
      : `The speculative market is frozen today — no trades worth the jump fuel.`,
    // template 7 - contrarian / value dip
    () => {
      const dips = highRisk.filter(i => parseFloat(i.priceChange30d) < -10);
      if (dips.length > 0) {
        return `Contrarian alert: ${dips.map(i => i.name).join(' and ')} ${dips.length > 1 ? 'have' : 'has'} dropped over 10% in 30 days. If you believe in a bounce, this is your entry — but volatility says the floor could still drop. Speculate responsibly.`;
      }
      return topHigh
        ? `The high-risk picks are running hot — ${topHigh.name} with ${sign(topHigh.priceChange30d)}% over 30 days shows the trend is strong. The question is whether you're catching the wave or the tail end of it.`
        : `The speculative board is quiet — sometimes patience is the best position.`;
    },
  ];

  // --- Select templates (different indices so intro and detail don't always pair the same way) ---
  const introParagraph = (lowRisk.length > 0 ? pick(introTemplates) : () => 'The low-risk segment is quiet today — check back tomorrow for new opportunities.')();
  const detailParagraph = (highRisk.length > 0 ? pick2(detailTemplates) : () => 'No standout high-risk picks today — sometimes the best trade is no trade at all.')();

  return { introParagraph, detailParagraph };
}

// ===== REPORT GENERATION =====

/**
 * Generates HTML report from EVE analysis results
 * @param {Object} eveData - EVE analysis results
 * @param {Object} opinion - AI-generated opinion { introParagraph, detailParagraph }
 * @returns {string} HTML report
 */
function generateReport(eveData, opinion) {
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
    const generateItemsHtml = (items) => {
      if (items.length === 0) {
        return `<tr><td><p class="no-items">No items found</p></td></tr>`;
      }
      return items.map((item, index) => `              <tr>
                <td style="vertical-align: top;${index < items.length - 1 ? ' padding-bottom: 8px;' : ''}">
            <div class="grid-item">
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="width: 64px; vertical-align: top;">
                    <img src="https://images.evetech.net/types/${item.id}/icon" alt="${escapeHtml(item.name)}">
                  </td>
                  <td class="grid-item-content">
                    <h4><a href="https://evemarketbrowser.com/region/0/type/${item.id}" target="_blank">${escapeHtml(item.name)}</a></h4>
                    <div class="item-metrics">
                      <span>Price: ${formatISK(item.currentPrice)}</span>
                      <span>Volume: ${item.volumeCategory}</span>
                      <span>Volatility: ${item.volatility}%</span>
                      <span>Momentum: ${item.momentum > 0 ? '+' : ''}${item.momentum}%</span>
                    </div>
                  </td>
                </tr>
              </table>
            </div>
                </td>
              </tr>`).join('\n');
    };

    contentHtml = `
      <h2 style="text-align: center; margin-top: 0;">Recommendations</h2>
      
      <table class="recommendations-table" cellpadding="0" cellspacing="0">
        <tr>
          <td class="risk-section">
            <h3>High Risk</h3>
            <table class="items-table" cellpadding="0" cellspacing="0">
${generateItemsHtml(highRisk)}
            </table>
          </td>
        </tr>
        <tr>
          <td class="risk-section">
            <h3>Low Risk</h3>
            <table class="items-table" cellpadding="0" cellspacing="0">
${generateItemsHtml(lowRisk)}
            </table>
          </td>
        </tr>
      </table>
    `;
  }

  // Read existing index.html and update only the dynamic content
  let template = fs.readFileSync('docs/eve/index.html', 'utf8');
  
  // Update the content section using comment markers for reliable matching
  template = template.replace(
    /<!-- EVE_CONTENT_START -->[\s\S]*?<!-- EVE_CONTENT_END -->/,
    `<!-- EVE_CONTENT_START -->\n${contentHtml}\n    <!-- EVE_CONTENT_END -->`
  );

  // Update the opinion section
  if (opinion) {
    // Update the intro paragraph using comment markers
    template = template.replace(
      /<!-- EVE_OPINION_INTRO_START -->[\s\S]*?<!-- EVE_OPINION_INTRO_END -->/,
      `<!-- EVE_OPINION_INTRO_START --><em>${currentDate}</em> — ${escapeHtml(opinion.introParagraph)}<!-- EVE_OPINION_INTRO_END -->`
    );

    // Update the detail paragraph using comment markers
    if (opinion.detailParagraph) {
      template = template.replace(
        /<!-- EVE_OPINION_DETAIL_START -->[\s\S]*?<!-- EVE_OPINION_DETAIL_END -->/,
        `<!-- EVE_OPINION_DETAIL_START -->${escapeHtml(opinion.detailParagraph)}<!-- EVE_OPINION_DETAIL_END -->`
      );
    }
  }
  
  return template;
}

/**
 * Escapes HTML special characters in a string
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
 */
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
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
    
    // Save the populated history and ETags (streaming to avoid max string length)
    await writeJsonStreaming(HISTORY_FILE, historyData);
    await writeJsonStreaming(ETAGS_FILE, etagData);
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
    
    // Load previous results for historical comparison
    let previousResults = null;
    try {
      const prevData = fs.readFileSync('eve-results.json', 'utf-8');
      previousResults = JSON.parse(prevData);
      console.log('📋 Loaded previous results for comparison');
    } catch (e) {
      console.log('ℹ️ No previous results found for comparison');
    }
    
    // Save results to JSON
    fs.writeFileSync('eve-results.json', JSON.stringify(results, null, 2));
    
    // Generate AI opinion piece
    const opinion = await generateOpinion(results, previousResults);
    
    // Generate and update the index.html file
    const reportHtml = generateReport(results, opinion);
    fs.writeFileSync('docs/eve/index.html', reportHtml);
    
    // Append to recommendations log
    try {
      let log = [];
      try {
        const existing = fs.readFileSync(RECOMMENDATIONS_LOG_FILE, 'utf-8');
        log = JSON.parse(existing);
      } catch (e) {
        // No existing log file, start fresh
      }
      
      const logEntry = {
        date: new Date().toISOString(),
        highRisk: (results.highRisk || []).map(item => ({
          id: item.id,
          name: item.name,
          currentPrice: item.currentPrice,
          priceChange: item.priceChange,
          priceChange7d: item.priceChange7d,
          priceChange30d: item.priceChange30d,
          volatility: item.volatility,
          momentum: item.momentum,
          volume: item.volume,
          volumeCategory: item.volumeCategory,
          investmentScore: item.investmentScore,
          dataPoints: item.dataPoints
        })),
        lowRisk: (results.lowRisk || []).map(item => ({
          id: item.id,
          name: item.name,
          currentPrice: item.currentPrice,
          priceChange: item.priceChange,
          priceChange7d: item.priceChange7d,
          priceChange30d: item.priceChange30d,
          volatility: item.volatility,
          momentum: item.momentum,
          volume: item.volume,
          volumeCategory: item.volumeCategory,
          investmentScore: item.investmentScore,
          dataPoints: item.dataPoints
        })),
        aiAnalysis: opinion ? {
          introParagraph: opinion.introParagraph,
          detailParagraph: opinion.detailParagraph
        } : null,
        metadata: results.metadata
      };
      
      log.push(logEntry);
      fs.writeFileSync(RECOMMENDATIONS_LOG_FILE, JSON.stringify(log, null, 2));
      console.log(`📝 Appended to recommendations log (${log.length} entries total)`);
    } catch (logError) {
      console.error('⚠️ Failed to update recommendations log:', logError.message);
    }
    
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
    
    // Send newsletter (disabled)
    // const subscribers = await loadSubscribers();
    // await sendNewsletter(subscribers);
    
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
    
    // Generate error report and update index.html (no opinion for errors)
    const reportHtml = generateReport(errorResult, null);
    fs.writeFileSync('docs/eve/index.html', reportHtml);
    
    process.exit(1);
  }
}

// Run main function if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}