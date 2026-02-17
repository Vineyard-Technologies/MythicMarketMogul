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
const DELAY_MS = 3000; // Delay between requests (3 seconds)

/**
 * Delays execution for a specified time
 * @param {number} ms - Milliseconds to wait
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetches all orders for a region across all pages
 * @param {number} regionId - EVE region ID
 * @returns {Promise<Array>} All orders for the region
 */
async function fetchAllOrdersForRegion(regionId) {
  console.log(`\nFetching orders for region ${regionId}...`);
  const allOrders = [];
  let page = 1;
  
  // Fetch first page to get total page count
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
    
    // Get total pages from header
    const totalPages = parseInt(response.headers.get('X-Pages') || '1');
    console.log(`  Found ${totalPages} pages`);
    console.log(`  Page 1: ${firstPageOrders.length} orders`);
    
    // Fetch remaining pages
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
  
  // Track order counts
  const regionOrderCounts = {};
  const itemOrderCounts = {};
  
  // Fetch orders for each region
  console.log('📊 Fetching orders from ESI API...');
  console.log('');
  
  for (let i = 0; i < regionNames.length; i++) {
    const regionName = regionNames[i];
    const regionId = regionsData[regionName];
    
    console.log(`[${i + 1}/${regionNames.length}] Processing ${regionName} (${regionId})`);
    
    const orders = await fetchAllOrdersForRegion(regionId);
    regionOrderCounts[regionName] = orders.length;
    
    // Count orders per item (type_id)
    for (const order of orders) {
      const typeId = order.type_id;
      if (!itemOrderCounts[typeId]) {
        itemOrderCounts[typeId] = 0;
      }
      itemOrderCounts[typeId]++;
    }
    
    // Delay between regions to be nice to the API
    if (i < regionNames.length - 1) {
      await delay(DELAY_MS * 2);
    }
  }
  
  console.log('');
  console.log('✅ All orders fetched!');
  console.log('');
  
  // Sort regions by order count (descending)
  console.log('🔄 Sorting regions by order volume...');
  const sortedRegions = Object.entries(regionsData)
    .sort((a, b) => {
      const countA = regionOrderCounts[a[0]] || 0;
      const countB = regionOrderCounts[b[0]] || 0;
      return countB - countA;
    })
    .reduce((obj, [name, id]) => {
      obj[name] = id;
      return obj;
    }, {});
  
  // Display top 10 regions
  console.log('  Top 10 regions by order volume:');
  Object.entries(regionOrderCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .forEach(([name, count], i) => {
      console.log(`    ${i + 1}. ${name}: ${count.toLocaleString()} orders`);
    });
  console.log('');
  
  // Sort items by order count (descending)
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
  console.log('✅ Done! Files sorted by order volume.');
}

// Run main function
main().catch(error => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
