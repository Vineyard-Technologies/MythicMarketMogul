import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ITEM_LIST_URL = 'https://chisel.weirdgloop.org/gazproj/gazbot/os_dump.json';
const HISTORY_API_BASE = 'https://api.weirdgloop.org/exchange/history/osrs/all?id=';
const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'osrs-history.json');
const DELAY_MS = 10000; // 10 seconds between requests

// Helper function to delay execution
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Fetch item list
async function fetchItemList() {
    console.log('Fetching item list...');
    const response = await fetch(ITEM_LIST_URL);
    if (!response.ok) {
        throw new Error(`Failed to fetch item list: ${response.statusText}`);
    }
    const data = await response.json();
    return data;
}

// Fetch historical data for a specific item
async function fetchItemHistory(itemId) {
    console.log(`Fetching history for item ID: ${itemId}`);
    const response = await fetch(`${HISTORY_API_BASE}${itemId}`);
    
    // Check for rate limiting (429) or other error responses
    if (!response.ok) {
        if (response.status === 429) {
            console.error(`\n❌ RATE LIMITED (HTTP 429) on item ${itemId}`);
            console.error('Exiting script to avoid wasting requests. Please wait before running again.');
            process.exit(1);
        }
        console.error(`\n❌ HTTP ${response.status} error for item ${itemId}: ${response.statusText}`);
        console.error('Exiting script due to API error.');
        process.exit(1);
    }
    
    const data = await response.json();
    
    // Validate that we got usable data
    if (!data || typeof data !== 'object') {
        console.error(`\n❌ Invalid data returned for item ${itemId}`);
        console.error('Expected an object but got:', typeof data);
        console.error('Exiting script due to unusable data.');
        process.exit(1);
    }
    
    return data;
}

// Main function to populate the history file
async function populateOsrsMarketHistory() {
    try {
        // Fetch the item list
        const itemData = await fetchItemList();
        
        // Extract item IDs from the dump
        // The structure might vary, so we need to handle different formats
        let itemIds = [];
        
        if (Array.isArray(itemData)) {
            itemIds = itemData.map(item => item.id).filter(id => id != null);
        } else if (typeof itemData === 'object') {
            // If it's an object, get all IDs from the values
            itemIds = Object.values(itemData)
                .map(item => item.id || item.ID)
                .filter(id => id != null);
        }
        
        console.log(`Found ${itemIds.length} items to process`);
        
        // Calculate and display time estimate
        const totalEstimatedSeconds = itemIds.length * (DELAY_MS / 1000);
        const estimatedHours = Math.floor(totalEstimatedSeconds / 3600);
        const estimatedMinutes = Math.floor((totalEstimatedSeconds % 3600) / 60);
        console.log(`Estimated time: ${estimatedHours}h ${estimatedMinutes}m (${itemIds.length} items × ${DELAY_MS / 1000}s)`);
        console.log('---');
        
        // Initialize or load existing history data
        let historyData = {};
        try {
            const existingData = await fs.readFile(OUTPUT_FILE, 'utf-8');
            historyData = JSON.parse(existingData);
            console.log(`Loaded existing data for ${Object.keys(historyData).length} items`);
        } catch (error) {
            console.log('No existing history file found, starting fresh');
        }
        
        // Track start time
        const startTime = Date.now();
        
        // Process each item with delay
        for (let i = 0; i < itemIds.length; i++) {
            const itemId = itemIds[i];
            
            // Fetch history for this item
            const history = await fetchItemHistory(itemId);
            
            // Save the data (fetchItemHistory will exit on errors)
            historyData[itemId] = history;
            
            // Save progress after each item
            await fs.writeFile(OUTPUT_FILE, JSON.stringify(historyData, null, 2));
            
            // Calculate progress statistics
            const itemsCompleted = i + 1;
            const itemsRemaining = itemIds.length - itemsCompleted;
            const elapsedMs = Date.now() - startTime;
            const elapsedSeconds = Math.floor(elapsedMs / 1000);
            const elapsedMinutes = Math.floor(elapsedSeconds / 60);
            const elapsedHours = Math.floor(elapsedMinutes / 60);
            
            // Calculate remaining time based on actual elapsed time
            const avgTimePerItem = elapsedMs / itemsCompleted;
            const remainingMs = avgTimePerItem * itemsRemaining;
            const remainingSeconds = Math.floor(remainingMs / 1000);
            const remainingMinutes = Math.floor(remainingSeconds / 60);
            const remainingHours = Math.floor(remainingMinutes / 60);
            
            // Format elapsed time
            const elapsedStr = `${elapsedHours}h ${elapsedMinutes % 60}m ${elapsedSeconds % 60}s`;
            // Format remaining time
            const remainingStr = `${remainingHours}h ${remainingMinutes % 60}m ${remainingSeconds % 60}s`;
            
            console.log(`✓ Completed item ${itemId}`);
            console.log(`Progress: ${itemsCompleted}/${itemIds.length} items | ${itemsRemaining} remaining`);
            console.log(`Elapsed: ${elapsedStr} | Remaining: ${remainingStr}`);
            console.log('---');
            
            // Wait before next request (except for the last item)
            if (i < itemIds.length - 1) {
                console.log(`Waiting ${DELAY_MS / 1000} seconds before next request...`);
                await delay(DELAY_MS);
            }
        }
        
        console.log('✓ All items processed successfully!');
        console.log(`Total items in history: ${Object.keys(historyData).length}`);
        
    } catch (error) {
        console.error('Error populating OSRS market history:', error);
        process.exit(1);
    }
}

// Run the script
populateOsrsMarketHistory();

export { populateOsrsMarketHistory };
