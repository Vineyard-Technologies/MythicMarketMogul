/**
 * Sorts eve-items.json and eve-regions.json by order volume
 * Queries ESI API to count orders for each region and item
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ITEMS_FILE = path.join(__dirname, 'data', 'eve-items.json');
const REGIONS_FILE = path.join(__dirname, 'data', 'eve-regions.json');
const USER_AGENT = 'eve-market-sorter/1.0 (GitHub Actions)';
const DELAY_MS = 1000;

/**
 * Delays execution for a specified time
 * @param {number} ms - Milliseconds to wait
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetches page 1 for a region and returns the X-Pages count
 * @param {number} regionId - EVE region ID
 * @returns {Promise<number>} Total number of order pages
 */
async function fetchPageCount(regionId) {
  const url = `https://esi.evetech.net/latest/markets/${regionId}/orders/?datasource=tranquility&order_type=all&page=1`;
  
  try {
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': USER_AGENT
      }
    });
    
    if (!response.ok) {
      console.error(`  ❌ HTTP ${response.status}`);
      return 0;
    }
    
    const totalPages = parseInt(response.headers.get('X-Pages') || '1');
    console.log(`  ${totalPages} pages`);
    return totalPages;
    
  } catch (error) {
    console.error(`  ❌ ${error.message}`);
    return 0;
  }
}

/**
 * Fetches all orders for a region across all pages
 * @param {number} regionId - EVE region ID
 * @returns {Promise<Array>} All orders for the region
 */
async function fetchAllOrdersForRegion(regionId) {
  console.log(`\nFetching all orders for region ${regionId}...`);
  const allOrders = [];
  
  const firstUrl = `https://esi.evetech.net/latest/markets/${regionId}/orders/?datasource=tranquility&order_type=all&page=1`;
  
  try {
    const response = await fetch(firstUrl, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': USER_AGENT
      }
    });
    
    if (!response.ok) {
      console.error(`  ❌ Failed to fetch page 1: HTTP ${response.status}`);
      return [];
    }
    
    const firstPageOrders = await response.json();
    allOrders.push(...firstPageOrders);
    
    const totalPages = parseInt(response.headers.get('X-Pages') || '1');
    console.log(`  Found ${totalPages} pages`);
    console.log(`  Page 1: ${firstPageOrders.length} orders`);
    
    for (let page = 2; page <= totalPages; page++) {
      await delay(DELAY_MS);
      
      const url = `https://esi.evetech.net/latest/markets/${regionId}/orders/?datasource=tranquility&order_type=all&page=${page}`;
      
      try {
        const pageResponse = await fetch(url, {
          headers: {
            'Accept': 'application/json',
            'User-Agent': USER_AGENT
          }
        });
        
        if (!pageResponse.ok) {
          console.error(`  ❌ Failed to fetch page ${page}: HTTP ${pageResponse.status}`);
          continue;
        }
        
        const pageOrders = await pageResponse.json();
        allOrders.push(...pageOrders);
        
        if (page % 10 === 0 || page === totalPages) {
          console.log(`  Page ${page}/${totalPages}: ${allOrders.length} total orders so far`);
        }
      } catch (error) {
        console.error(`  ❌ Error fetching page ${page}: ${error.message}`);
      }
    }
    
    console.log(`  ✅ Total orders for region ${regionId}: ${allOrders.length}`);
    return allOrders;
    
  } catch (error) {
    console.error(`  ❌ Error fetching orders for region ${regionId}: ${error.message}`);
    return [];
  }
}

/**
 * Main function
 */
async function main() {
  const startTime = Date.now();
  console.log('🚀 EVE Items and Regions Sorter');
  console.log('================================');
  console.log('');
  
  // Load regions and items
  console.log('📂 Loading data files...');
  const regionsData = JSON.parse(fs.readFileSync(REGIONS_FILE, 'utf-8'));
  const itemsData = JSON.parse(fs.readFileSync(ITEMS_FILE, 'utf-8'));
  
  const regionNames = Object.keys(regionsData);
  console.log(`  Loaded ${regionNames.length} regions`);
  console.log(`  Loaded ${Object.keys(itemsData).length} items`);
  console.log('');
  
  // Track page counts per region
  const regionPageCounts = {};
  
  // Phase 1: Fetch page counts for each region (one request each)
  console.log('📊 Phase 1: Fetching page counts for each region...');
  console.log('');
  
  for (let i = 0; i < regionNames.length; i++) {
    const regionName = regionNames[i];
    const regionId = regionsData[regionName];
    
    console.log(`[${i + 1}/${regionNames.length}] ${regionName} (${regionId})`);
    
    const pageCount = await fetchPageCount(regionId);
    regionPageCounts[regionName] = pageCount;
    
    if (i < regionNames.length - 1) {
      await delay(DELAY_MS);
    }
  }
  
  // Sort regions by page count (descending)
  console.log('');
  console.log('🔄 Sorting regions by page count...');
  const sortedRegionEntries = Object.entries(regionsData)
    .sort((a, b) => {
      const countA = regionPageCounts[a[0]] || 0;
      const countB = regionPageCounts[b[0]] || 0;
      return countB - countA;
    });
  
  const sortedRegions = sortedRegionEntries
    .reduce((obj, [name, id]) => {
      obj[name] = id;
      return obj;
    }, {});
  
  // Display top 10 regions
  console.log('  Top 10 regions by page count:');
  sortedRegionEntries
    .slice(0, 10)
    .forEach(([name], i) => {
      console.log(`    ${i + 1}. ${name}: ${regionPageCounts[name]} pages`);
    });
  console.log('');
  
  // Phase 2: Fetch all orders from the top region to sort items
  const topRegionName = sortedRegionEntries[0][0];
  const topRegionId = sortedRegionEntries[0][1];
  console.log(`📊 Phase 2: Fetching all orders from top region "${topRegionName}" to sort items...`);
  
  const orders = await fetchAllOrdersForRegion(topRegionId);
  
  // Count orders per item (type_id)
  const itemOrderCounts = {};
  for (const order of orders) {
    const typeId = order.type_id;
    if (!itemOrderCounts[typeId]) {
      itemOrderCounts[typeId] = 0;
    }
    itemOrderCounts[typeId]++;
  }
  
  console.log('');
  console.log('🔄 Sorting items by order volume...');
  
  // Create reverse lookup from typeId to name
  const typeIdToName = {};
  for (const [name, typeId] of Object.entries(itemsData)) {
    typeIdToName[typeId] = name;
  }
  
  const sortedItems = Object.entries(itemOrderCounts)
    .sort((a, b) => b[1] - a[1])
    .reduce((obj, [typeId, count]) => {
      const itemName = typeIdToName[typeId];
      if (itemName) {
        obj[itemName] = parseInt(typeId);
      }
      return obj;
    }, {});
  
  // Display top 10 items
  console.log('  Top 10 items by order volume:');
  Object.entries(itemOrderCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .forEach(([typeId, count], i) => {
      const name = typeIdToName[typeId] || `Unknown (${typeId})`;
      console.log(`    ${i + 1}. ${name}: ${count.toLocaleString()} orders`);
    });
  console.log('');
  
  // Save sorted files
  console.log('💾 Saving sorted files...');
  fs.writeFileSync(REGIONS_FILE, JSON.stringify(sortedRegions, null, 2));
  console.log(`  ✅ Saved ${REGIONS_FILE}`);
  
  fs.writeFileSync(ITEMS_FILE, JSON.stringify(sortedItems, null, 2));
  console.log(`  ✅ Saved ${ITEMS_FILE}`);
  
  console.log('');
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const minutes = Math.floor(elapsed / 60);
  const seconds = (elapsed % 60).toFixed(1);
  console.log(`✅ Done! Files sorted by order volume. (${minutes}m ${seconds}s)`);
}

// Run main function
main().catch(error => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
