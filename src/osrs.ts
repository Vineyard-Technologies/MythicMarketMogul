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
const pkg = require('../package.json') as { name: string; version: string };

// ===== TYPE DEFINITIONS =====

interface OsrsPricePoint {
  timestamp: number;
  price: number;
}

interface OsrsPriceData {
  daily: Record<string, number>;
  volume: Record<string, number>;
}

interface OsrsHistoricalItem {
  name: string;
  daily: Record<string, number>;
  volume: Record<string, number>;
}

interface OsrsHistoricalData {
  [itemId: string]: OsrsHistoricalItem;
}

interface OsrsItemInfo {
  id: number;
  name: string;
  members: boolean;
  volume: number;
}

interface OsrsItemDumpEntry {
  id?: number;
  name?: string;
  members?: boolean;
  price?: number;
  volume?: number;
  [key: string]: unknown;
}

interface OsrsItemDatabase {
  [id: string]: OsrsItemDumpEntry;
}

interface OsrsAnalysisResult {
  id: number;
  name: string;
  currentPrice: number;
  startPrice: number;
  priceChange: string;
  volume: number;
  volumeCategory: string;
  volatility: string;
  momentum: string;
  investmentScore: string;
  dataPoints: number;
  members: boolean;
  riskLevel: 'high' | 'low';
}

interface OsrsAutomatedResults {
  highRiskMembers: OsrsAnalysisResult[];
  lowRiskMembers: OsrsAnalysisResult[];
  highRiskF2P: OsrsAnalysisResult[];
  lowRiskF2P: OsrsAnalysisResult[];
  totalAnalyzed: number;
  totalChecked: number;
  metadata?: OsrsResultMetadata;
  error?: string;
}

interface OsrsResultMetadata {
  itemsAnalyzed: number;
  analysisTime: string;
  timestamp: string;
  environment: string;
  failed?: boolean;
}

interface RunOptions {
  isGitHubActions?: boolean;
  logFile?: string | null;
}

// OSRS constants
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

const USER_AGENT = `${pkg.name}/${pkg.version} (${getGitHubEmail()}; +${getRepoUrl()})`;

// Path to local history file
const HISTORY_FILE = path.join(__dirname, '..', 'data', 'osrs-history.json');

// ===== LOCAL HISTORY FUNCTIONS =====

/**
 * Loads historical data from local file
 */
function loadHistoricalData(): OsrsHistoricalData {
  if (!fs.existsSync(HISTORY_FILE)) {
    console.log('📝 Creating new history file...');
    fs.writeFileSync(HISTORY_FILE, JSON.stringify({}));
    return {};
  }
  return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
}

/**
 * Saves updated historical data (minified for space efficiency)
 */
function saveHistoricalData(data: OsrsHistoricalData): void {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(data));
}

/**
 * Updates local history with today's data from Weirdgloop API
 */
function updateLocalHistory(itemId: number, itemName: string, currentPrice: number, volume: number): OsrsPriceData {
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
 */
function getPriceHistory(itemId: number, itemName: string, currentPrice: number, volume: number): OsrsPriceData {
  return updateLocalHistory(itemId, itemName, currentPrice, volume);
}

/**
 * Fetches item data from the OSRS item database
 */
async function fetchItemDatabase(): Promise<OsrsItemDatabase> {
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
    const data: OsrsItemDatabase = await response.json();
    console.log('✅ Item database loaded\n');
    return data;
  } catch (error) {
    console.error('Error fetching item database:', (error as Error).message);
    process.exit(1);
  }
}

// ===== ANALYSIS FUNCTIONS =====

/**
 * Converts price history object to sorted array of price points
 */
function convertToArray(priceData: Record<string, number>): OsrsPricePoint[] {
  return Object.entries(priceData)
    .map(([timestamp, price]) => ({
      timestamp: parseInt(timestamp),
      price: price
    }))
    .sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Calculates the percentage change in price over the period
 */
function calculatePriceChange(prices: OsrsPricePoint[]): number {
  if (prices.length < 2) return 0;
  
  const firstPrice = prices[0].price;
  const lastPrice = prices[prices.length - 1].price;
  
  return ((lastPrice - firstPrice) / firstPrice) * 100;
}

/**
 * Calculates price volatility (standard deviation)
 */
function calculateVolatility(prices: OsrsPricePoint[]): number {
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
 */
function calculateMomentum(prices: OsrsPricePoint[]): number {
  if (prices.length < 60) return 0;
  
  const recent30 = prices.slice(-30);
  const previous30 = prices.slice(-60, -30);
  
  const recent30Avg = recent30.reduce((sum, p) => sum + p.price, 0) / recent30.length;
  const previous30Avg = previous30.reduce((sum, p) => sum + p.price, 0) / previous30.length;
  
  return ((recent30Avg - previous30Avg) / previous30Avg) * 100;
}

/**
 * Calculates an investment score based on multiple factors
 */
function calculateInvestmentScore(priceChange: number, volatility: number, momentum: number): number {
  let score = 50;
  
  if (volatility >= 20) {
    score += 30;
  } else {
    score += (volatility / 20) * 30;
  }
  
  score += Math.min(momentum * 3, 30);
  
  if (priceChange >= 40) {
    score += 30;
  } else if (priceChange > 0) {
    score += (priceChange / 40) * 30;
  }
  
  if (momentum > 10 && priceChange > 30 && volatility > 15) {
    score += 10;
  }
  
  return Math.max(0, Math.min(100, score));
}

/**
 * Categorizes volume into descriptive levels
 */
function categorizeVolume(volume: number): string {
  if (volume >= 1000000) return 'Very High';
  if (volume >= 100000) return 'High';
  if (volume >= 10000) return 'Medium';
  if (volume >= 1000) return 'Low';
  return 'Very Low';
}

/**
 * Analyzes an item's price history
 */
function analyzeItem(priceData: OsrsPriceData, itemInfo: OsrsItemInfo): OsrsAnalysisResult | null {
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
  
  const riskLevel: 'high' | 'low' = parseFloat(volatility.toFixed(2)) >= 15 ? 'high' : 'low';
  
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
    riskLevel
  };
}

// ===== MAIN APPLICATION =====

/**
 * Automated OSRS analysis
 */
export async function runOSRSAutomated(options: RunOptions = {}): Promise<OsrsAutomatedResults> {
  const { isGitHubActions = false, logFile = null } = options;
  
  const logMessage = (message: string): void => {
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
  const allItems: OsrsItemInfo[] = Object.entries(itemsData)
    .filter(([id, item]) => {
      if (!item.name || item.price === undefined || item.volume === undefined) {
        return false;
      }
      return true;
    })
    .map(([id, item]) => ({
      id: parseInt(id),
      name: item.name!,
      members: item.members !== false,
      volume: item.volume!
    }));

  logMessage(`Found ${allItems.length} suitable items`);
  
  // Analyze ALL suitable items (no limit)
  const shuffledItems = [...allItems].sort(() => Math.random() - 0.5);
  const itemsToAnalyze = shuffledItems;
  
  logMessage(`Analyzing ALL ${itemsToAnalyze.length} items...`);
  logMessage('');

  const results: OsrsAnalysisResult[] = [];
  let itemsChecked = 0;
  let successfulAnalyses = 0;

  for (let i = 0; i < itemsToAnalyze.length; i++) {
    const item = itemsToAnalyze[i];
    itemsChecked++;
    
    logMessage(`Progress: ${itemsChecked}/${itemsToAnalyze.length} - Checking ${item.name}...`);
    
    const itemData = itemsData[item.id];
    const currentPrice = itemData.price!;
    
    const priceData = getPriceHistory(item.id, item.name, currentPrice, item.volume);
    
    if (priceData) {
      const analysis = analyzeItem(priceData, item);
      
      if (analysis) {
        results.push(analysis);
        successfulAnalyses++;
        logMessage(`  ✓ Analyzed (${successfulAnalyses} total)`);
      }
    }
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
 */
function formatGP(amount: number): string {
  return `${amount.toLocaleString()} gold`;
}

/**
 * Generates HTML email report from OSRS analysis results
 */
function generateEmailReport(osrsData: OsrsAutomatedResults): string {
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
    const { highRiskMembers = [], lowRiskMembers = [], highRiskF2P = [], lowRiskF2P = [] } = osrsData;
    
    // Helper function to generate items HTML
    const generateItemsHtml = (items: OsrsAnalysisResult[], category: string): string => {
      if (items.length === 0) {
        return '<p class="no-items">No items found</p>';
      }
      return items.map((item) => `
            <div class="grid-item">
              <table>
                <tr>
                  <td style="width: 32px; vertical-align: top;">
                    <img src="https://secure.runescape.com/m=itemdb_oldschool/obj_sprite.gif?id=${item.id}" alt="${item.name}">
                  </td>
                  <td class="grid-item-content" style="vertical-align: top;">
                    <h4><a href="https://secure.runescape.com/m=itemdb_oldschool/viewitem?obj=${item.id}" target="_blank" style="color: #333; text-decoration: none;">${item.name}</a></h4>
                    <div class="item-metrics">
                      <span>Price: ${formatGP(item.currentPrice)}</span>
                      <span>Volume: ${item.volumeCategory}</span>
                      <span>Volatility: ${item.volatility}%</span>
                      <span>Momentum: ${parseFloat(item.momentum) > 0 ? '+' : ''}${item.momentum}%</span>
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
 */
async function loadSubscribers(): Promise<string[]> {
  const apiKey = process.env.BREVO_API_KEY;
  const listId = 4; // OSRS Newsletter list
  
  if (!apiKey) {
    console.log('⚠️ BREVO_API_KEY not set.');
    return [];
  }
  
  try {
    const client = new brevo.BrevoClient({ apiKey });
    
    const response = await client.contacts.getContactsFromList({ listId, limit: 500, offset: 0 });
    const emails = (response as any).contacts.map((contact: any) => contact.email) as string[];
    
    console.log(`📋 Loaded ${emails.length} OSRS subscribers from Brevo list ${listId}`);
    return emails;
  } catch (error) {
    console.error('❌ Failed to load subscribers from Brevo:', (error as Error).message);
    if ((error as any).response) {
      console.error('Response data:', (error as any).response.body);
      console.error('Status code:', (error as any).response.statusCode);
    }
    console.log('\n💡 TIP: List ID 4 may not exist. Falling back to test mode.');
    console.log('    Add your email below or create list ID 4 in Brevo dashboard.');
    
    return ['laserwolve@gmail.com'];
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
    console.log('📭 No OSRS subscribers found. Skipping newsletter.');
    return;
  }
  
  try {
    const client = new brevo.BrevoClient({ apiKey });
    
    const htmlContent = fs.readFileSync('docs/osrs/index.html', 'utf8');
    
    const currentDate = new Date().toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
    
    const subject = `Old School RuneScape Market Analysis - ${currentDate}`;
    
    console.log(`\n📧 Sending OSRS newsletter to ${subscribers.length} subscriber(s)...`);
    console.log(`Recipients: ${subscribers.join(', ')}`);
    console.log(`Subject: ${subject}`);
    
    const response = await client.transactionalEmails.sendTransacEmail({
      subject,
      htmlContent,
      sender: {
        name: 'Mythic Market Mogul',
        email: 'reports@vineyardtechnologies.org'
      },
      to: subscribers.map(email => ({ email })),
      replyTo: {
        email: 'reports@vineyardtechnologies.org',
        name: 'Mythic Market Mogul'
      }
    });
    console.log(`✅ Newsletter sent successfully!`);
    console.log(`Message ID: ${(response as any).messageId}`);
    console.log(`Full response:`, JSON.stringify(response, null, 2));
  } catch (error) {
    console.error(`❌ Failed to send newsletter:`, (error as Error).message);
    if ((error as any).response) {
      console.error('Error response body:', (error as any).response.body);
      console.error('Error status code:', (error as any).response.statusCode);
    }
    console.error('Full error:', error);
  }
}

// ===== GITHUB ACTIONS RUNNER =====

/**
 * Main entry point when run directly
 */
async function main(): Promise<void> {
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
    console.error('❌ OSRS Analysis failed:', (error as Error).message);
    
    const errorResult: OsrsAutomatedResults = {
      error: (error as Error).message,
      highRiskMembers: [],
      lowRiskMembers: [],
      highRiskF2P: [],
      lowRiskF2P: [],
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
    
    fs.writeFileSync('osrs-results.json', JSON.stringify(errorResult, null, 2));
    
    const reportHtml = generateEmailReport(errorResult);
    fs.writeFileSync('docs/osrs/index.html', reportHtml);
    
    process.exit(1);
  }
}

// Run main function if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
