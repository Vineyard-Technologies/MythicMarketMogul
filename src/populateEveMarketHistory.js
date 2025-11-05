// This takes a little under 6 days to run

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TYPES_API_BASE = 'https://esi.evetech.net/universe/types?page=';
const HISTORY_API_BASE = 'https://esi.evetech.net/latest/markets/10000002/history/?datasource=tranquility&type_id=';
const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'eve-history.json');
const DELAY_MS = 10000; // 10 seconds between requests

// Helper function to delay execution
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Fetch all type IDs from paginated API
async function fetchAllTypeIds() {
    console.log('Fetching all type IDs from EVE API...');
    const allTypeIds = [];
    let page = 1;
    let hasMorePages = true;
    
    while (hasMorePages) {
        console.log(`Fetching type IDs from page ${page}...`);
        const response = await fetch(`${TYPES_API_BASE}${page}`);
        
        // 404 means we've reached the end of available pages
        if (response.status === 404) {
            console.log(`Page ${page} not found - reached end of type IDs`);
            hasMorePages = false;
            break;
        }
        
        if (!response.ok) {
            console.error(`\n❌ HTTP ${response.status} error fetching type IDs page ${page}: ${response.statusText}`);
            console.error('Exiting script due to API error.');
            process.exit(1);
        }
        
        const typeIds = await response.json();
        
        // Check if we got valid data
        if (!Array.isArray(typeIds)) {
            console.error(`\n❌ Invalid data returned for type IDs page ${page}`);
            console.error('Expected an array but got:', typeof typeIds);
            console.error('Exiting script due to unusable data.');
            process.exit(1);
        }
        
        // If we got no results, we're done
        if (typeIds.length === 0) {
            hasMorePages = false;
            console.log(`No more type IDs found on page ${page}`);
        } else {
            allTypeIds.push(...typeIds);
            console.log(`Found ${typeIds.length} type IDs on page ${page} (total: ${allTypeIds.length})`);
            page++;
            
            // Wait before fetching next page
            if (hasMorePages) {
                console.log(`Waiting ${DELAY_MS / 1000} seconds before next page...`);
                await delay(DELAY_MS);
            }
        }
    }
    
    console.log(`\n✅ Fetched ${allTypeIds.length} total type IDs from ${page - 1} pages`);
    return allTypeIds;
}

// Fetch historical data for a specific type
async function fetchTypeHistory(typeId) {
    console.log(`Fetching history for type ID: ${typeId}`);
    const response = await fetch(`${HISTORY_API_BASE}${typeId}`);
    
    // Check for rate limiting (429) or other error responses
    if (!response.ok) {
        if (response.status === 429) {
            console.error(`\n❌ RATE LIMITED (HTTP 429) on type ${typeId}`);
            console.error('Exiting script to avoid wasting requests. Please wait before running again.');
            process.exit(1);
        }
        
        // For 404 or other errors, check if it's a "Type not found" error
        if (response.status === 404) {
            try {
                const errorData = await response.json();
                if (errorData.error === "Type not found!") {
                    console.log(`Type ${typeId} is not marketable, skipping...`);
                    return null; // Skip non-marketable items
                }
            } catch {
                // If we can't parse the error, treat it as a regular error
            }
        }
        
        console.error(`\n❌ HTTP ${response.status} error for type ${typeId}: ${response.statusText}`);
        console.error('Exiting script due to API error.');
        process.exit(1);
    }
    
    const data = await response.json();
    
    // Check for error object in response
    if (data && data.error === "Type not found!") {
        console.log(`Type ${typeId} is not marketable, skipping...`);
        return null;
    }
    
    // Validate that we got usable data (should be an array)
    if (!Array.isArray(data)) {
        console.error(`\n❌ Invalid data returned for type ${typeId}`);
        console.error('Expected an array but got:', typeof data);
        console.error('Exiting script due to unusable data.');
        process.exit(1);
    }
    
    return data;
}

// Main function to populate the history file
async function populateEveMarketHistory() {
    try {
        // Fetch all type IDs
        const typeIds = await fetchAllTypeIds();
        
        console.log(`\nStarting market history collection for ${typeIds.length} type IDs`);
        
        // Calculate and display time estimate
        const totalEstimatedSeconds = typeIds.length * (DELAY_MS / 1000);
        const estimatedHours = Math.floor(totalEstimatedSeconds / 3600);
        const estimatedMinutes = Math.floor((totalEstimatedSeconds % 3600) / 60);
        console.log(`Estimated time: ${estimatedHours}h ${estimatedMinutes}m (${typeIds.length} items × ${DELAY_MS / 1000}s)`);
        console.log('---');
        
        // Initialize or load existing history data
        let historyData = {};
        try {
            const existingData = await fs.readFile(OUTPUT_FILE, 'utf-8');
            historyData = JSON.parse(existingData);
            console.log(`Loaded existing data for ${Object.keys(historyData).length} types`);
        } catch (error) {
            console.log('No existing history file found, starting fresh');
        }
        
        // Track start time
        const startTime = Date.now();
        let marketableCount = 0;
        let nonMarketableCount = 0;
        
        // Process each type with delay
        for (let i = 0; i < typeIds.length; i++) {
            const typeId = typeIds[i];
            
            // Fetch history for this type
            const history = await fetchTypeHistory(typeId);
            
            if (history !== null) {
                // Save the data (only for marketable items)
                historyData[typeId] = history;
                marketableCount++;
                
                // Save progress after each item
                await fs.writeFile(OUTPUT_FILE, JSON.stringify(historyData, null, 2));
                
                console.log(`✓ Completed type ${typeId}`);
            } else {
                nonMarketableCount++;
            }
            
            // Wait before next request (except for the last item)
            if (i < typeIds.length - 1) {
                console.log(`Waiting ${DELAY_MS / 1000} seconds before next request...`);
                await delay(DELAY_MS);
            }
            
            // Calculate progress statistics
            const itemsCompleted = i + 1;
            const itemsRemaining = typeIds.length - itemsCompleted;
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
            
            console.log(`Progress: ${itemsCompleted}/${typeIds.length} types | ${itemsRemaining} remaining`);
            console.log(`Marketable: ${marketableCount} | Non-marketable: ${nonMarketableCount}`);
            console.log(`Elapsed: ${elapsedStr} | Remaining: ${remainingStr}`);
            console.log('---');
        }
        
        console.log('✅ All types processed successfully!');
        console.log(`Total marketable types in history: ${Object.keys(historyData).length}`);
        console.log(`Total non-marketable types skipped: ${nonMarketableCount}`);
        
    } catch (error) {
        console.error('Error populating EVE market history:', error);
        process.exit(1);
    }
}

// Run the script
populateEveMarketHistory();

export { populateEveMarketHistory };
