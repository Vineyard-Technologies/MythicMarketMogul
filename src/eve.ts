import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import * as brevo from '@getbrevo/brevo';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { name: string; version: string };
const HISTORY_FILE = path.join(__dirname, '..', 'data', 'eve-history.json');
const ITEMS_FILE = path.join(__dirname, '..', 'data', 'eve-items.json');
const REGIONS_FILE = path.join(__dirname, '..', 'data', 'eve-regions.json');
const ETAGS_FILE = path.join(__dirname, '..', 'data', 'eve-etags.json');
const RECOMMENDATIONS_LOG_FILE = path.join(__dirname, '..', 'data', 'eve-recommendations-log.json');
const API_REQUEST_DELAY = 1000; // Milliseconds between ESI API calls
const NUMBER_OF_ITEMS_TO_PROCESS = 10000;

// ===== TYPE DEFINITIONS =====

interface MarketHistoryEntry {
  date: string;
  average: number;
  highest: number;
  lowest: number;
  volume: number;
  order_count: number;
}

interface AggregationAccumulator {
  date: string;
  totalVolume: number;
  weightedAvgSum: number;
  highest: number;
  lowest: number;
  orderCount: number;
}

interface HistoryData {
  [regionId: string]: {
    [typeId: string]: MarketHistoryEntry[];
  };
}

interface AggregatedData {
  [typeId: string]: MarketHistoryEntry[];
}

interface ETagEntry {
  etag?: string;
  lastModified?: string;
}

interface ETagData {
  [regionId: string]: {
    [typeId: string]: ETagEntry;
  };
}

interface ItemInfo {
  id: number;
  name: string;
}

interface AnalysisResult {
  id: number;
  name: string;
  currentPrice: number;
  priceChange: string;
  priceChange7d: string;
  priceChange30d: string;
  volatility: string;
  momentum: string;
  volume: number;
  volumeCategory: string;
  investmentScore: string;
  dataPoints: number;
  riskLevel: 'high' | 'low';
}

interface MarketOverview {
  totalItems: number;
  avgMomentum: string;
  avgVolatility: string;
  itemsUp: number;
  itemsDown: number;
  itemsFlat: number;
}

interface NotableMover {
  name: string;
  priceChange7d: string;
  currentPrice: number;
  volumeCategory: string;
}

interface NotableMovers {
  biggestGainers: NotableMover[];
  biggestLosers: NotableMover[];
}

interface EVEAutomatedResults {
  highRisk: AnalysisResult[];
  lowRisk: AnalysisResult[];
  marketOverview: MarketOverview;
  notableMovers: NotableMovers;
  totalAnalyzed: number;
  totalChecked: number;
  metadata?: ResultMetadata;
  error?: string;
}

interface ResultMetadata {
  itemsAnalyzed: number;
  itemsFetched?: number;
  analysisTime: string;
  timestamp: string;
  environment: string;
  failed?: boolean;
}

interface OpinionResult {
  introParagraph: string;
  detailParagraph: string;
}

interface RecommendationLogEntry {
  date: string;
  highRisk: Partial<AnalysisResult>[];
  lowRisk: Partial<AnalysisResult>[];
  aiAnalysis: OpinionResult | null;
  metadata?: ResultMetadata;
}

interface RunOptions {
  logFile?: string | null;
}

// Dynamically construct USER_AGENT from GitHub Actions environment
const getGitHubEmail = (): string => {
  const actor = process.env.GITHUB_ACTOR;
  if (!actor) {
    throw new Error('GITHUB_ACTOR environment variable not set');
  }
  return `${actor}@users.noreply.github.com`;
};

const getRepoUrl = (): string => {
  const serverUrl = process.env.GITHUB_SERVER_URL;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!serverUrl || !repository) {
    throw new Error('GitHub environment variables (GITHUB_SERVER_URL, GITHUB_REPOSITORY) not set');
  }
  return `${serverUrl}/${repository}`;
};

// USER_AGENT will be constructed when needed
let USER_AGENT: string | null = null;

const getUserAgent = (): string => {
  if (!USER_AGENT) {
    USER_AGENT = `${pkg.name}/${pkg.version} (${getGitHubEmail()}; +${getRepoUrl()})`;
  }
  return USER_AGENT;
};

/**
 * Delays execution for a specified time
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Writes a large two-level nested object to a JSON file using streaming to
 * avoid exceeding Node.js's maximum string length with JSON.stringify.
 * Serializes each leaf value (e.g. a single item's history array) individually.
 * Expected structure: { outerKey: { innerKey: value, ... }, ... }
 */
async function writeJsonStreaming(filePath: string, data: Record<string, Record<string, unknown>>): Promise<void> {
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

/**
 * Aggregates market history across all regions into a single dataset per item.
 * Uses volume-weighted average price, summed volumes, max high, min low.
 */
function aggregateRegionData(historyData: HistoryData): AggregatedData {
  const byTypeAndDate: Record<string, Record<string, AggregationAccumulator>> = {};

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
  const result: AggregatedData = {};
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
 */
function calculatePriceChange(history: MarketHistoryEntry[]): number {
  if (history.length < 2) return 0;
  
  const firstPrice = history[0].average;
  const lastPrice = history[history.length - 1].average;
  
  return ((lastPrice - firstPrice) / firstPrice) * 100;
}

/**
 * Calculates price volatility (standard deviation)
 */
function calculateVolatility(history: MarketHistoryEntry[]): number {
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
 */
function calculateMomentum(history: MarketHistoryEntry[]): number {
  if (history.length < 60) return 0;
  
  const recent30 = history.slice(-30);
  const previous30 = history.slice(-60, -30);
  
  const recent30Avg = recent30.reduce((sum, day) => sum + day.average, 0) / recent30.length;
  const previous30Avg = previous30.reduce((sum, day) => sum + day.average, 0) / previous30.length;
  
  return ((recent30Avg - previous30Avg) / previous30Avg) * 100;
}

/**
 * Calculates an investment score based on multiple factors
 */
function calculateInvestmentScore(priceChange: number, volatility: number, momentum: number): number {
  // Strategy: High-volatility items with positive momentum
  let score = 50; // Base score
  
  // High volatility is GOOD for speculation (up to +30 points)
  if (volatility >= 20) {
    score += 30;
  } else {
    score += (volatility / 20) * 30;
  }
  
  // Strong positive momentum is critical (up to +30 points)
  score += Math.min(momentum * 3, 30);
  
  // Recent strong price change indicates potential (up to +30 points)
  if (priceChange >= 40) {
    score += 30;
  } else if (priceChange > 0) {
    score += (priceChange / 40) * 30;
  }
  
  // Bonus for items showing breakout potential
  if (momentum > 10 && priceChange > 30 && volatility > 15) {
    score += 10;
  }
  
  return Math.max(0, Math.min(100, score));
}

/**
 * Categorizes volume into descriptive levels
 */
function categorizeVolume(volume: number): string {
  if (volume >= 10000) return 'Very High';
  if (volume >= 1000) return 'High';
  if (volume >= 100) return 'Medium';
  if (volume >= 10) return 'Low';
  return 'Very Low';
}

/**
 * Formats ISK amount with appropriate suffix
 */
function formatISK(amount: number): string {
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
 */
function analyzeItem(history: MarketHistoryEntry[], itemInfo: ItemInfo): AnalysisResult | null {
  if (!history || history.length === 0) {
    return null;
  }
  
  // Sort by date
  history.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  
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
  
  const riskLevel: 'high' | 'low' = parseFloat(volatility.toFixed(2)) >= 15 ? 'high' : 'low';
  
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
    riskLevel
  };
}

// ===== MAIN APPLICATION =====

/**
 * Automated EVE analysis for GitHub Actions
 */
export async function runEVEAutomated(options: RunOptions = {}): Promise<EVEAutomatedResults> {
  const { logFile = null } = options;
  
  const logMessage = (message: string): void => {
    console.log(message);
    if (logFile) {
      const timestamp = new Date().toISOString();
      fs.appendFileSync(logFile, `${timestamp}: ${message}\n`);
    }
  };

  logMessage('🚀 EVE Online Investment Analyzer');
  logMessage('===================================');
  
  logMessage(`Analyzing items from history data`);
  logMessage('');

  // Load history data (nested: regionId -> typeId -> entries)
  let rawHistoryData: HistoryData;
  try {
    const historyContent = await fs.promises.readFile(HISTORY_FILE, 'utf-8');
    rawHistoryData = JSON.parse(historyContent);
    const regionCount = Object.keys(rawHistoryData).length;
    logMessage(`✅ Loaded history across ${regionCount} regions`);
  } catch (error) {
    throw new Error(`Could not load history data: ${(error as Error).message}`);
  }

  // Aggregate across regions for analysis
  logMessage('Aggregating data across all regions...');
  const historyData = aggregateRegionData(rawHistoryData);
  logMessage(`✅ Aggregated data for ${Object.keys(historyData).length} unique items`);

  // Load item names from eve-items.json
  let itemsData: Record<string, number>;
  try {
    const itemsContent = await fs.promises.readFile(ITEMS_FILE, 'utf-8');
    itemsData = JSON.parse(itemsContent);
    logMessage(`✅ Loaded ${Object.keys(itemsData).length} item names`);
  } catch (error) {
    throw new Error(`Could not load items data: ${(error as Error).message}`);
  }

  // Create a reverse lookup map (typeId -> name)
  const typeIdToName: Record<string, string> = {};
  for (const [name, typeId] of Object.entries(itemsData)) {
    typeIdToName[typeId] = name;
  }

  logMessage('');

  const results: AnalysisResult[] = [];
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
      const itemInfo: ItemInfo = {
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

  // Categorize results into 2 groups
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

  const marketOverview: MarketOverview = {
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
  
  const notableMovers: NotableMovers = {
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
 */
async function generateOpinion(analysisData: EVEAutomatedResults, previousResults: EVEAutomatedResults | null = null): Promise<OpinionResult> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.log('⚠️ GITHUB_TOKEN not set. Using default opinion.');
    return getDefaultOpinion(analysisData);
  }

  const { highRisk = [], lowRisk = [], marketOverview = {} as MarketOverview, notableMovers = {} as NotableMovers } = analysisData;

  // Build a summary of the recommended items with price history
  const highRiskSummary = highRisk.map(item =>
    `- ${item.name}: ${formatISK(item.currentPrice)}, Volume: ${item.volumeCategory}, Volatility: ${item.volatility}%, Momentum: ${item.momentum > '0' ? '+' : ''}${item.momentum}%, 7d change: ${parseFloat(item.priceChange7d) > 0 ? '+' : ''}${item.priceChange7d}%, 30d change: ${parseFloat(item.priceChange30d) > 0 ? '+' : ''}${item.priceChange30d}%`
  ).join('\n');

  const lowRiskSummary = lowRisk.map(item =>
    `- ${item.name}: ${formatISK(item.currentPrice)}, Volume: ${item.volumeCategory}, Volatility: ${item.volatility}%, Momentum: ${item.momentum > '0' ? '+' : ''}${item.momentum}%, 7d change: ${parseFloat(item.priceChange7d) > 0 ? '+' : ''}${item.priceChange7d}%, 30d change: ${parseFloat(item.priceChange30d) > 0 ? '+' : ''}${item.priceChange30d}%`
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
        moversText += `\n- ${g.name}: ${parseFloat(g.priceChange7d) > 0 ? '+' : ''}${g.priceChange7d}% (${formatISK(g.currentPrice)}, Volume: ${g.volumeCategory})`;
      }
    }
    if (notableMovers.biggestLosers?.length > 0) {
      moversText += '\nBiggest Losers:';
      for (const l of notableMovers.biggestLosers) {
        moversText += `\n- ${l.name}: ${parseFloat(l.priceChange7d) > 0 ? '+' : ''}${l.priceChange7d}% (${formatISK(l.currentPrice)}, Volume: ${l.volumeCategory})`;
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
    const log: RecommendationLogEntry[] = JSON.parse(logContent);
    const recentEntries = log
      .filter(entry => entry.aiAnalysis && entry.aiAnalysis.introParagraph)
      .slice(-3);
    if (recentEntries.length > 0) {
      recentAnalysesText = '\n\nYOUR RECENT OPINION PIECES (do NOT repeat these — write something fresh and different):';
      for (const entry of recentEntries) {
        const entryDate = new Date(entry.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        recentAnalysesText += `\n\n[${entryDate}]:\n${entry.aiAnalysis!.introParagraph}\n${entry.aiAnalysis!.detailParagraph}`;
      }
    }
  } catch {
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
  const todayAngle = angles[Math.floor(Date.now() / 86400000) % angles.length];

  const prompt = `You are Foggle Lopperbottom, a savvy EVE Online market analyst who writes daily trading opinion pieces. You have a casual but knowledgeable tone — you speak like an experienced trader sharing tips with friends. You know EVE Online lore, items, and market mechanics well.

Here are today's recommended items:

HIGH RISK (volatile, speculative):
${highRiskSummary}

LOW RISK (stable, consistent):
${lowRiskSummary}${marketOverviewText}${moversText}${comparisonText}${recentAnalysesText}

TODAY'S ANGLE: ${todayAngle}

Write a short opinion piece with exactly TWO paragraphs:

1. FIRST PARAGRAPH: Commentary on the low-risk picks and/or market-wide trends. Start directly with your analysis (no date prefix, that's added separately).

2. SECOND PARAGRAPH: Commentary on the high-risk picks — highlight specific items by name.

Rules:
- Keep it concise — each paragraph should be 2-3 sentences max
- Sound natural and conversational, like you're chatting with fellow capsuleers
- Reference specific item names from the data
- Use the market overview, notable movers, and changes from yesterday to add color and context where relevant — don't just repeat the numbers
- IMPORTANT: Vary your sentence structure, opening words, and phrasing. Do NOT start paragraphs the same way as your recent pieces shown above. Use different sentence patterns and fresh angles each day.
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
        max_tokens: 400,
        temperature: 0.8
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ GitHub Models API error (HTTP ${response.status}): ${errorText}`);
      return getDefaultOpinion(analysisData);
    }

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
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
    console.error(`❌ Failed to generate AI opinion: ${(error as Error).message}`);
    return getDefaultOpinion(analysisData);
  }
}

/**
 * Returns a default opinion when AI generation is unavailable
 */
function getDefaultOpinion(analysisData: EVEAutomatedResults): OpinionResult {
  const { highRisk = [], lowRisk = [] } = analysisData;

  const lowRiskNames = lowRisk.slice(0, 3).map(i => i.name).join(', ');
  const topHighRisk = highRisk[0];

  return {
    introParagraph: lowRisk.length > 0
      ? `The low-risk segment continues to show steady performance with items like ${lowRiskNames}. Their consistent volume and low volatility make them solid choices for traders looking to preserve capital.`
      : 'The low-risk segment is quiet today — check back tomorrow for new opportunities.',
    detailParagraph: topHighRisk
      ? `On the high-risk side, keep an eye on ${topHighRisk.name} at ${formatISK(topHighRisk.currentPrice)} with ${parseFloat(topHighRisk.momentum) > 0 ? '+' : ''}${topHighRisk.momentum}% momentum. Volatile picks like these can pay off big if you time your trades right.`
      : 'No standout high-risk picks today — sometimes the best trade is no trade at all.'
  };
}

// ===== REPORT GENERATION =====

/**
 * Generates HTML report from EVE analysis results
 */
function generateReport(eveData: EVEAutomatedResults, opinion: OpinionResult | null): string {
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
    const { highRisk = [], lowRisk = [] } = eveData;
    
    // Helper function to generate items HTML
    const generateItemsHtml = (items: AnalysisResult[]): string => {
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
                      <span>Momentum: ${parseFloat(item.momentum) > 0 ? '+' : ''}${item.momentum}%</span>
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
 */
function escapeHtml(text: string): string {
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
 */
async function loadSubscribers(): Promise<string[]> {
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
    const response = await apiInstance.getContactsFromList(listId, undefined, 500, 0);
    const emails = (response as any).contacts.map((contact: any) => contact.email) as string[];
    
    console.log(`📋 Loaded ${emails.length} EVE subscribers from Brevo list ${listId}`);
    return emails;
  } catch (error) {
    console.error('❌ Failed to load subscribers from Brevo:', (error as Error).message);
    return [];
  }
}

/**
 * Sends newsletter via Brevo
 */
async function sendNewsletter(subscribers: string[]): Promise<void> {
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
    console.log(`✅ Newsletter sent successfully! Message ID: ${(response as any).messageId}`);
  } catch (error) {
    console.error(`❌ Failed to send newsletter:`, (error as Error).message);
    // Don't throw - newsletter failure shouldn't break the analysis
  }
}

// ===== GITHUB ACTIONS RUNNER =====

/**
 * Main entry point for GitHub Actions workflow
 */
async function main(): Promise<void> {
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
    const itemsData: Record<string, number> = JSON.parse(await fs.promises.readFile(itemsFilePath, 'utf-8'));
    const itemNames = Object.keys(itemsData);
    const totalItems = itemNames.length;
    
    // Load regions from eve-regions.json
    const regionsData: Record<string, number> = JSON.parse(await fs.promises.readFile(REGIONS_FILE, 'utf-8'));
    const regionNames = Object.keys(regionsData);
    const totalRegions = regionNames.length;
    const totalRequests = totalRegions * totalItems;
    
    console.log(`Found ${totalItems} items across ${totalRegions} regions (${totalRequests.toLocaleString()} total requests)`);
    console.log('');
    
    // Load existing history if available
    let historyData: HistoryData = {};
    try {
      const existingData = await fs.promises.readFile(HISTORY_FILE, 'utf-8');
      historyData = JSON.parse(existingData);
      const existingRegions = Object.keys(historyData).length;
      console.log(`Loaded existing history for ${existingRegions} regions`);
    } catch {
      console.log('No existing history file found, starting fresh');
    }
    
    // Load cached ETags for conditional requests
    let etagData: ETagData = {};
    try {
      const existingEtags = await fs.promises.readFile(ETAGS_FILE, 'utf-8');
      etagData = JSON.parse(existingEtags);
      console.log('Loaded cached ETags for conditional requests');
    } catch {
      console.log('No cached ETags found, all requests will be full fetches');
    }
    
    // Fetch history for each region and item
    let fetched = 0;
    let skipped = 0;
    let errors = 0;
    let requestCount = 0;
    
    for (let r = 0; r < totalRegions; r++) {
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
        const headers: Record<string, string> = {
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
            continue;
          } else {
            console.error(`  Error fetching ${itemName} (${typeId}) in ${regionName}: HTTP ${response.status}`);
            errors++;
          }
        } catch (error) {
          console.error(`  Error fetching ${itemName} (${typeId}) in ${regionName}: ${(error as Error).message}`);
          errors++;
        }
        
        // Delay between API calls
        await delay(API_REQUEST_DELAY);
      }
    }
    
    // Save the populated history and ETags (streaming to avoid max string length)
    await writeJsonStreaming(HISTORY_FILE, historyData as unknown as Record<string, Record<string, unknown>>);
    await writeJsonStreaming(ETAGS_FILE, etagData as unknown as Record<string, Record<string, unknown>>);
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
    let previousResults: EVEAutomatedResults | null = null;
    try {
      const prevData = fs.readFileSync('eve-results.json', 'utf-8');
      previousResults = JSON.parse(prevData);
      console.log('📋 Loaded previous results for comparison');
    } catch {
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
      let log: RecommendationLogEntry[] = [];
      try {
        const existing = fs.readFileSync(RECOMMENDATIONS_LOG_FILE, 'utf-8');
        log = JSON.parse(existing);
      } catch {
        // No existing log file, start fresh
      }
      
      const logEntry: RecommendationLogEntry = {
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
      console.error('⚠️ Failed to update recommendations log:', (logError as Error).message);
    }
    
    console.log('\n✅ Analysis Complete!');
    console.log(`Total time: ${results.metadata!.analysisTime}`);
    console.log(`Items fetched: ${fetched}`);
    console.log(`Items analyzed: ${results.metadata!.itemsAnalyzed}`);
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
    console.error('❌ Analysis failed:', (error as Error).message);
    console.error((error as Error).stack);
    
    // Save error info
    const errorResult: EVEAutomatedResults = {
      error: (error as Error).message,
      highRisk: [],
      lowRisk: [],
      marketOverview: { totalItems: 0, avgMomentum: '0', avgVolatility: '0', itemsUp: 0, itemsDown: 0, itemsFlat: 0 },
      notableMovers: { biggestGainers: [], biggestLosers: [] },
      totalAnalyzed: 0,
      totalChecked: 0,
      metadata: {
        timestamp: new Date().toISOString(),
        environment: 'GitHub Actions',
        failed: true,
        itemsAnalyzed: 0,
        analysisTime: '0m 0s'
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
