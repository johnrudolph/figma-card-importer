// Card Sync — Figma sandbox (code.ts)
// All canvas manipulation happens here. No network access.

interface CardTypeConfig {
  tabName: string;
  enabled: boolean;
  frontComponentKey: string;
  backComponentKey: string;
}

interface Settings {
  sheetUrl: string;
  cardTypes: CardTypeConfig[];
}

interface CardRow {
  name: string;        // Unique key (deduplicated: "Show solidarity (2)")
  _displayName: string; // Original name for display on the card
  [field: string]: string;
}

interface RunSyncPayload {
  cardTypes: CardTypeConfig[];
  sheetData: { [tabName: string]: CardRow[] };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendProgress(message: string, level: 'info' | 'warn' | 'error' = 'info') {
  figma.ui.postMessage({ type: 'PROGRESS', payload: { message, level } });
}

/** Find a top-level frame on the current page by name. */
function findFrame(name: string): FrameNode | null {
  return figma.currentPage.children.find(
    (n) => n.type === 'FRAME' && n.name === name
  ) as FrameNode | null;
}

/** Create a top-level frame at the given position. */
function createFrame(name: string, x: number, y: number): FrameNode {
  const frame = figma.createFrame();
  frame.name = name;
  frame.x = x;
  frame.y = y;
  frame.resize(1, 1);
  frame.clipsContent = false;
  frame.fills = [];
  return frame;
}

/** Extract the field name from a Figma layer name (everything after the first `#`,
 *  with any leading non-word chars like `/` stripped — so both `#title` and
 *  `#/show_action` yield the column key). */
function extractFieldName(layerName: string): string {
  const hash = layerName.indexOf('#');
  if (hash === -1) return '';
  return layerName.substring(hash + 1).replace(/^[^a-z0-9_]+/i, '').toLowerCase();
}

/** Find a row's key matching `field` case-insensitively, or null if absent. */
function findFieldKey(row: CardRow, field: string): string | null {
  const target = field.toLowerCase();
  for (const key of Object.keys(row)) {
    if (key.toLowerCase() === target) return key;
  }
  return null;
}

/** Read a row's value for `field` (case-insensitive), trimmed; '' if absent. */
function getFieldValue(row: CardRow, field: string): string {
  const key = findFieldKey(row, field);
  const val = key ? row[key] : '';
  return typeof val === 'string' ? val.trim() : '';
}

/** Resolve a component by node ID (local) or key (library). */
async function getComponent(keyOrId: string): Promise<ComponentNode | null> {
  try {
    const node = await figma.getNodeByIdAsync(keyOrId);
    if (node && node.type === 'COMPONENT') return node as ComponentNode;
  } catch (e) {
    // not a valid ID, try as key
  }
  try {
    const imported = await figma.importComponentByKeyAsync(keyOrId);
    return imported;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Art Bank — image lookup by card name
// ---------------------------------------------------------------------------

/** Build a map of card name (lowercase) → image fills from the art_bank frame. */
function buildArtBank(): Map<string, Paint[]> {
  const bank = new Map<string, Paint[]>();
  const bankFrame = findFrame('art_bank');
  if (!bankFrame) return bank;

  for (const child of bankFrame.children) {
    if ('fills' in child) {
      const fills = (child as GeometryMixin).fills;
      if (fills && fills !== figma.mixed && (fills as Paint[]).length > 0) {
        bank.set(child.name.toLowerCase(), fills as Paint[]);
      }
    }
  }
  return bank;
}

// ---------------------------------------------------------------------------
// Working Frames
// ---------------------------------------------------------------------------

let nextFrameY = 0;

function resolveWorkingFrame(name: string): FrameNode {
  let frame = findFrame(name);
  if (!frame) {
    frame = createFrame(name, 0, nextFrameY);
  }
  const bottom = frame.y + Math.max(frame.height, 100) + 200;
  if (bottom > nextFrameY) nextFrameY = bottom;
  return frame;
}

// ---------------------------------------------------------------------------
// Sync Component Instances
// ---------------------------------------------------------------------------

function buildNameMap(frame: FrameNode): Map<string, InstanceNode> {
  const map = new Map<string, InstanceNode>();
  for (const child of frame.children) {
    if (child.type === 'INSTANCE') {
      map.set(child.name.toLowerCase(), child);
    }
  }
  return map;
}

async function syncInstances(
  frame: FrameNode,
  component: ComponentNode,
  rows: CardRow[],
  side: 'front' | 'back'
): Promise<Map<string, InstanceNode>> {
  const existing = buildNameMap(frame);
  const activeNames = new Set(rows.map((r) => r.name.toLowerCase()));
  const result = new Map<string, InstanceNode>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const key = row.name.toLowerCase();
    let instance = existing.get(key);
    if (!instance) {
      instance = component.createInstance();
      frame.appendChild(instance);
      sendProgress(`Created ${side} instance for "${row.name}"`);
    }
    instance.name = row.name;
    // Record the Google Sheet row index so PDF + TTS output follow sheet order.
    instance.setPluginData(SHEET_INDEX_KEY, String(i));
    result.set(row.name, instance);
  }

  // Delete instances no longer in the sheet
  for (const [nameKey, instance] of existing) {
    if (!activeNames.has(nameKey)) {
      instance.remove();
      sendProgress(`Removed stale ${side} instance "${instance.name}"`, 'warn');
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Populate Fields
// ---------------------------------------------------------------------------

async function populateInstanceAsync(
  instance: InstanceNode,
  row: CardRow,
  artBank: Map<string, Paint[]>
) {
  const descendants = instance.findAll((n) => n.name.indexOf('#') !== -1);

  for (const node of descendants) {
    const fieldName = extractFieldName(node.name);
    if (!fieldName) continue;

    // Art field — fill from art_bank by card display name
    if (fieldName === 'art') {
      const artKey = row._displayName.toLowerCase();
      const artFills = artBank.get(artKey);
      if (artFills && 'fills' in node) {
        (node as GeometryMixin).fills = artFills;
      }
      continue;
    }

    // For the "name" field, use the original display name (without dedup suffix)
    if (fieldName === 'name') {
      if (node.type === 'TEXT') {
        (node as TextNode).characters = row._displayName;
      }
      continue;
    }

    const matchingKey = Object.keys(row).find((k) => k.toLowerCase() === fieldName);
    if (!matchingKey) continue;

    const value = row[matchingKey];

    // Show/Hide convention
    if (value.toLowerCase() === 'show') {
      node.visible = true;
      continue;
    }
    if (value.toLowerCase() === 'hide') {
      node.visible = false;
      continue;
    }

    // Text field population (fonts are pre-loaded in bulk before this runs)
    if (node.type === 'TEXT') {
      (node as TextNode).characters = value;
    }
  }
}

// ---------------------------------------------------------------------------
// Sort Instances by Google Sheet order
// ---------------------------------------------------------------------------

// Plugin-data key holding each card's original Google Sheet row index. Stamped
// at sync time; survives clone()/detachInstance() into the print frames, so the
// PDF and TTS exports can both reproduce the sheet's order instead of A–Z.
const SHEET_INDEX_KEY = 'sheetIndex';

/** Read a node's stamped sheet-row index (cards with none sort to the end). */
function sheetOrderKey(node: SceneNode): number {
  const raw = node.getPluginData(SHEET_INDEX_KEY);
  if (!raw) return Number.MAX_SAFE_INTEGER;
  const n = parseInt(raw, 10);
  return isNaN(n) ? Number.MAX_SAFE_INTEGER : n;
}

/** Comparator: Google Sheet row order, with card name as a stable tiebreaker. */
function bySheetOrder(a: SceneNode, b: SceneNode): number {
  return sheetOrderKey(a) - sheetOrderKey(b) || a.name.localeCompare(b.name);
}

function sortAndLayoutInstances(frame: FrameNode, cardWidth: number, cardHeight: number) {
  const instances = frame.children
    .filter((n): n is InstanceNode => n.type === 'INSTANCE')
    .sort(bySheetOrder);

  const gap = 8;
  let x = 0;
  let y = 0;

  for (const inst of instances) {
    inst.x = x;
    inst.y = y;
    x += cardWidth + gap;

    if (x > (cardWidth + gap) * 10) {
      x = 0;
      y += cardHeight + gap;
    }
  }

  for (let i = 0; i < instances.length; i++) {
    frame.insertChild(i, instances[i]);
  }
}

// ---------------------------------------------------------------------------
// Build Print Sheets
// ---------------------------------------------------------------------------

const PRINT_WIDTH = 816;   // 8.5" at 96 DPI
const PRINT_HEIGHT = 1056;  // 11" at 96 DPI
const PRINT_MARGIN = 18;

function buildPrintSheets(
  tabName: string,
  side: 'Fronts' | 'Backs',
  instances: InstanceNode[],
  cardWidth: number,
  cardHeight: number,
  startX: number,
  startY: number,
  mirrorRows: boolean = false
): FrameNode[] {
  const usableW = PRINT_WIDTH - PRINT_MARGIN * 2;
  const usableH = PRINT_HEIGHT - PRINT_MARGIN * 2;

  const cols = Math.floor(usableW / cardWidth);
  const rows = Math.floor(usableH / cardHeight);
  const cardsPerSheet = cols * rows;

  if (cardsPerSheet === 0) {
    sendProgress(`Cards too large to fit on print sheet for ${tabName} ${side}`, 'error');
    return [];
  }

  const gapX = 0;
  const gapY = 0;
  const blockW = cols * cardWidth;
  const blockH = rows * cardHeight;
  const offsetX = PRINT_MARGIN + (usableW - blockW) / 2;
  const offsetY = PRINT_MARGIN + (usableH - blockH) / 2;

  const sheets: FrameNode[] = [];
  let cardIndex = 0;
  let sheetNumber = 1;

  while (cardIndex < instances.length) {
    const sheetFrame = figma.createFrame();
    sheetFrame.name = `Print -- ${tabName} -- ${side} -- ${String(sheetNumber).padStart(2, '0')}`;
    sheetFrame.resize(PRINT_WIDTH, PRINT_HEIGHT);
    sheetFrame.x = startX + (sheets.length) * (PRINT_WIDTH + 32);
    sheetFrame.y = startY;
    sheetFrame.clipsContent = true;
    sheetFrame.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];

    for (let r = 0; r < rows && cardIndex < instances.length; r++) {
      for (let c = 0; c < cols && cardIndex < instances.length; c++) {
        try {
          const original = instances[cardIndex];
          const col = mirrorRows ? (cols - 1 - c) : c;

          // Clone the card
          const clone = original.clone();
          clone.x = offsetX + col * (cardWidth + gapX);
          clone.y = offsetY + r * (cardHeight + gapY);
          sheetFrame.appendChild(clone);

          // Detach this instance and all nested instances to prevent component reference issues
          // This must be done after appendChild because detaching changes the node type
          try {
            // First detach the main instance
            clone.detachInstance();

            // Then find and detach any nested instances within
            const nestedInstances = clone.findAll((n) => n.type === 'INSTANCE') as InstanceNode[];
            for (const nested of nestedInstances) {
              try {
                nested.detachInstance();
              } catch (nestedErr) {
                // Some instances might not be detachable, continue
              }
            }

            // Also validate and clean up any problematic image fills
            const nodesWithFills = clone.findAll((n) => 'fills' in n);
            for (const node of nodesWithFills) {
              try {
                const fills = (node as GeometryMixin).fills;
                if (fills !== figma.mixed && Array.isArray(fills)) {
                  // Try to access the fills to ensure they're valid
                  const validFills = fills.filter((fill) => {
                    if (fill.type === 'IMAGE') {
                      try {
                        // Try to access image hash to verify it's valid
                        const hash = fill.imageHash;
                        return hash !== undefined && hash !== null;
                      } catch {
                        return false; // Invalid image fill
                      }
                    }
                    return true; // Non-image fills are OK
                  });
                  if (validFills.length !== fills.length) {
                    (node as GeometryMixin).fills = validFills;
                  }
                }
              } catch (fillErr) {
                // If we can't access fills, set to empty
                try {
                  (node as GeometryMixin).fills = [];
                } catch {
                  // Can't fix this node, move on
                }
              }
            }
          } catch (detachErr) {
            // If detaching fails, the instance might already be detached or invalid
          }

          cardIndex++;
        } catch (cloneErr: any) {
          sendProgress(`Warning: Failed to clone card ${cardIndex}: ${cloneErr.message}`, 'warn');
          cardIndex++;
        }
      }
    }

    sheets.push(sheetFrame);
    sendProgress(`  Built ${side} sheet ${sheetNumber} (${sheetFrame.children.length} cards)`);
    sheetNumber++;
  }

  return sheets;
}

function deletePrintFrames(tabName: string) {
  const prefix = `Print -- ${tabName} --`;
  const toDelete = figma.currentPage.children.filter(
    (n) => n.type === 'FRAME' && n.name.startsWith(prefix)
  );
  for (const frame of toDelete) {
    frame.remove();
  }
}

// ---------------------------------------------------------------------------
// Component Discovery
// ---------------------------------------------------------------------------

async function getAllComponents(): Promise<{ name: string; key: string }[]> {
  const components: { name: string; key: string }[] = [];

  function walk(node: BaseNode) {
    if (node.type === 'COMPONENT') {
      components.push({ name: node.name, key: node.id });
    }
    if ('children' in node) {
      for (const child of (node as ChildrenMixin).children) {
        walk(child);
      }
    }
  }

  for (const page of figma.root.children) {
    await page.loadAsync();
    walk(page);
  }

  components.sort((a, b) => a.name.localeCompare(b.name));
  return components;
}

// ---------------------------------------------------------------------------
// Main Sync Orchestrator
// ---------------------------------------------------------------------------

async function runSync(payload: RunSyncPayload) {
  const { cardTypes, sheetData } = payload;

  // Calculate frame placement
  nextFrameY = 0;
  for (const child of figma.currentPage.children) {
    if (child.type === 'FRAME') {
      const bottom = child.y + child.height;
      if (bottom > nextFrameY) nextFrameY = bottom + 100;
    }
  }

  // Build art bank lookup
  const artBank = buildArtBank();
  if (artBank.size > 0) {
    sendProgress(`Art bank: ${artBank.size} images available`);
  }

  let totalCards = 0;
  const cardCounts: { [tabName: string]: number } = {};
  let printGroupY = 0;

  const printSheetGroups: {
    tabName: string;
    frontSheets: FrameNode[];
    backSheets: FrameNode[];
  }[] = [];

  // Per-card TTS metadata harvested from optional `tts_metadata` (searchable
  // Name) and `tts_description` (hover Description) sheet columns, keyed by
  // tab then card name. Persisted to the document so the TTS export — which
  // runs later off the print frames — can emit per-deck Lua tagging scripts.
  const ttsMeta: { [tab: string]: { [cardName: string]: { name?: string; desc?: string } } } = {};

  for (const ct of cardTypes) {
    if (!ct.enabled) continue;

    const rows = sheetData[ct.tabName];
    if (!rows || rows.length === 0) {
      sendProgress(`No data for tab "${ct.tabName}", skipping`, 'warn');
      continue;
    }

    sendProgress(`Processing "${ct.tabName}" — ${rows.length} cards`);

    const frontComp = await getComponent(ct.frontComponentKey);
    const backComp = await getComponent(ct.backComponentKey);

    if (!frontComp) {
      sendProgress(`Front component not found for "${ct.tabName}", skipping`, 'error');
      continue;
    }
    if (!backComp && ct.backComponentKey) {
      sendProgress(`Back component not found for "${ct.tabName}", skipping backs`, 'warn');
    }

    const cardWidth = frontComp.width;
    const cardHeight = frontComp.height;

    sendProgress(`Card size: ${cardWidth} × ${cardHeight} px`);

    // Working frames
    const frontsFrame = resolveWorkingFrame(`${ct.tabName} Fronts`);
    const backsFrame = backComp ? resolveWorkingFrame(`${ct.tabName} Backs`) : null;

    // Sync instances
    const frontInstances = await syncInstances(frontsFrame, frontComp, rows, 'front');
    let backInstances: Map<string, InstanceNode> = new Map();
    if (backComp && backsFrame) {
      backInstances = await syncInstances(backsFrame, backComp, rows, 'back');
    }

    // Pre-load ALL fonts used across all instances to avoid race conditions.
    // Figma's loadFontAsync can silently fail to stick when called rapidly
    // per-node, causing random cards to keep their placeholder text.
    sendProgress(`Loading fonts for "${ct.tabName}"...`);
    const fontsToLoad = new Set<string>();
    const allInstances = [
      ...Array.from(frontInstances.values()),
      ...Array.from(backInstances.values()),
    ];
    for (const inst of allInstances) {
      const textNodes = inst.findAll((n) => n.type === 'TEXT') as TextNode[];
      for (const tn of textNodes) {
        const len = tn.characters.length;
        if (len > 0) {
          for (const font of tn.getRangeAllFontNames(0, len)) {
            fontsToLoad.add(JSON.stringify(font));
          }
        } else if (tn.fontName !== figma.mixed) {
          fontsToLoad.add(JSON.stringify(tn.fontName));
        }
      }
    }
    for (const fontJson of fontsToLoad) {
      await figma.loadFontAsync(JSON.parse(fontJson));
    }
    sendProgress(`Loaded ${fontsToLoad.size} font(s). Populating fields...`);

    // Populate fields + art
    for (const row of rows) {
      const fi = frontInstances.get(row.name);
      const bi = backInstances.get(row.name);
      if (fi) await populateInstanceAsync(fi, row, artBank);
      if (bi) await populateInstanceAsync(bi, row, artBank);
    }

    // Verification pass — check for instances that failed to populate
    for (const row of rows) {
      const fi = frontInstances.get(row.name);
      if (fi) {
        const textNodes = fi.findAll((n) => n.type === 'TEXT') as TextNode[];
        for (const tn of textNodes) {
          if (tn.name.indexOf('#') !== -1) {
            const fieldName = extractFieldName(tn.name);
            if (!fieldName) continue;
            // Name field uses display name
            if (fieldName === 'name') {
              if (tn.characters !== row._displayName) {
                sendProgress(
                  `VERIFY FAIL: "${row.name}" field "name" expected="${row._displayName}" got="${tn.characters}"`,
                  'error'
                );
                try { tn.characters = row._displayName; } catch (e: any) { /* */ }
              }
              continue;
            }
            const matchingKey = Object.keys(row).find((k) => k.toLowerCase() === fieldName);
            if (matchingKey && row[matchingKey] && tn.characters !== row[matchingKey]) {
              const lowered = row[matchingKey].toLowerCase();
              if (lowered === 'show' || lowered === 'hide') continue;
              sendProgress(
                `VERIFY FAIL: "${row.name}" field "${fieldName}" expected="${row[matchingKey]}" got="${tn.characters}"`,
                'error'
              );
              // Retry the set
              try {
                tn.characters = row[matchingKey];
                sendProgress(`  Retried setting "${fieldName}" on "${row.name}"`, 'info');
              } catch (retryErr: any) {
                sendProgress(`  Retry failed: ${retryErr.message}`, 'error');
              }
            }
          }
        }
      }
    }

    // Sort
    sendProgress(`Sorting "${ct.tabName}" in sheet order...`);
    sortAndLayoutInstances(frontsFrame, cardWidth, cardHeight);
    if (backsFrame) sortAndLayoutInstances(backsFrame, cardWidth, cardHeight);

    // Harvest optional TTS metadata columns (case-insensitive, like #fields).
    const hasMetaCol = rows.length > 0 && findFieldKey(rows[0], 'tts_metadata') !== null;
    const hasDescCol = rows.length > 0 && findFieldKey(rows[0], 'tts_description') !== null;
    if (hasMetaCol || hasDescCol) {
      const tabMeta: { [cardName: string]: { name?: string; desc?: string } } = {};
      for (const row of rows) {
        const nameVal = hasMetaCol ? getFieldValue(row, 'tts_metadata') : '';
        const descVal = hasDescCol ? getFieldValue(row, 'tts_description') : '';
        if (nameVal || descVal) {
          const entry: { name?: string; desc?: string } = {};
          if (nameVal) entry.name = nameVal;
          if (descVal) entry.desc = descVal;
          tabMeta[row.name] = entry;
        }
      }
      ttsMeta[ct.tabName] = tabMeta;
      sendProgress(`  TTS metadata: tagged ${Object.keys(tabMeta).length} card(s) in "${ct.tabName}"`);
    }

    totalCards += rows.length;
    cardCounts[ct.tabName] = rows.length;

    printSheetGroups.push({
      tabName: ct.tabName,
      frontSheets: [],
      backSheets: [],
    });
  }

  // Print area start position
  printGroupY = 0;
  for (const child of figma.currentPage.children) {
    if (child.type === 'FRAME' && !child.name.startsWith('Print --')) {
      const bottom = child.y + child.height;
      if (bottom > printGroupY) printGroupY = bottom;
    }
  }
  printGroupY += 200;

  // Build print sheets
  let printX = 0;

  for (const group of printSheetGroups) {
    const ct = cardTypes.find((c) => c.tabName === group.tabName)!;
    const frontComp = await getComponent(ct.frontComponentKey);
    if (!frontComp) continue;

    const cardWidth = frontComp.width;
    const cardHeight = frontComp.height;

    deletePrintFrames(group.tabName);

    const frontsFrame = findFrame(`${group.tabName} Fronts`)!;

    const sortedFronts = frontsFrame.children
      .filter((n): n is InstanceNode => n.type === 'INSTANCE')
      .sort(bySheetOrder);

    sendProgress(`Building print sheets for "${group.tabName}"...`);

    group.frontSheets = buildPrintSheets(
      group.tabName, 'Fronts', sortedFronts,
      cardWidth, cardHeight, printX, printGroupY,
      false
    );

    const backsFrame = findFrame(`${group.tabName} Backs`);
    if (backsFrame) {
      const sortedBacks = backsFrame.children
        .filter((n): n is InstanceNode => n.type === 'INSTANCE')
        .sort(bySheetOrder);

      const backPrintY = printGroupY + PRINT_HEIGHT + 32;
      group.backSheets = buildPrintSheets(
        group.tabName, 'Backs', sortedBacks,
        cardWidth, cardHeight, printX, backPrintY,
        true
      );

      // Back sheets stay in the same order as front sheets.
      // The printer prints last-to-first, and after flipping the
      // front stack to reload, the physical sheet order reverses —
      // these two reversals cancel out, so no reordering is needed.
    }

    const sheetsWidth = Math.max(group.frontSheets.length, group.backSheets.length) * (PRINT_WIDTH + 32);
    printX += sheetsWidth + 64;

    sendProgress(
      `Print sheets for "${group.tabName}": ${group.frontSheets.length} front, ${group.backSheets.length} back`
    );
  }

  // Clean up working frames
  for (const group of printSheetGroups) {
    const frontsFrame = findFrame(`${group.tabName} Fronts`);
    const backsFrame = findFrame(`${group.tabName} Backs`);
    if (frontsFrame) frontsFrame.remove();
    if (backsFrame) backsFrame.remove();
  }

  // Persist TTS metadata for the export step (overwrites any prior run, so a
  // sheet that drops the columns clears stale data).
  figma.root.setPluginData('cardSyncTtsMeta', JSON.stringify(ttsMeta));

  figma.ui.postMessage({
    type: 'SYNC_COMPLETE',
    payload: { cardCounts, totalCards },
  });

  sendProgress(
    `Synced ${printSheetGroups.length} card type${printSheetGroups.length !== 1 ? 's' : ''} — ${totalCards} cards total. Print frames ready.`
  );
}

// ---------------------------------------------------------------------------
// Message Handler
// ---------------------------------------------------------------------------

figma.showUI(__html__, { width: 360, height: 520 });

figma.ui.onmessage = async (msg: { type: string; payload?: any }) => {
  switch (msg.type) {
    case 'GET_SETTINGS': {
      // apiKey is per-user (clientStorage); sheetUrl + cardTypes are per-file
      // (document plugin data) so configs don't bleed between Figma files.
      let apiKey: string = (await figma.clientStorage.getAsync('cardSyncApiKey')) || '';

      // One-time migration: legacy clientStorage blob held everything together.
      if (!apiKey) {
        const legacy = await figma.clientStorage.getAsync('cardSyncSettings');
        if (legacy && legacy.apiKey) {
          apiKey = legacy.apiKey;
          await figma.clientStorage.setAsync('cardSyncApiKey', apiKey);
        }
      }

      const raw = figma.root.getPluginData('cardSyncSettings');
      let sheetUrl = '';
      let cardTypes: CardTypeConfig[] = [];
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          sheetUrl = parsed.sheetUrl || '';
          cardTypes = parsed.cardTypes || [];
        } catch (_) {
          // ignore corrupt data — treat as empty
        }
      }

      figma.ui.postMessage({
        type: 'SETTINGS',
        payload: { apiKey, sheetUrl, cardTypes },
      });
      break;
    }

    case 'CHECK_PRINT_FRAMES': {
      const hasPrintFrames = figma.currentPage.children.some(
        (n) => n.type === 'FRAME' && n.name.startsWith('Print --')
      );
      figma.ui.postMessage({ type: 'PRINT_FRAMES_STATUS', payload: { exists: hasPrintFrames } });
      break;
    }

    case 'SAVE_SETTINGS': {
      const { apiKey, sheetUrl, cardTypes } = msg.payload || {};
      await figma.clientStorage.setAsync('cardSyncApiKey', apiKey || '');
      figma.root.setPluginData(
        'cardSyncSettings',
        JSON.stringify({ sheetUrl: sheetUrl || '', cardTypes: cardTypes || [] })
      );
      figma.ui.postMessage({ type: 'SETTINGS_SAVED', payload: null });
      break;
    }

    case 'GET_COMPONENTS': {
      const components = await getAllComponents();
      figma.ui.postMessage({ type: 'COMPONENTS', payload: components });
      break;
    }

    case 'GET_COMPONENT_SIZE': {
      const comp = await getComponent(msg.payload.key);
      if (comp) {
        figma.ui.postMessage({
          type: 'COMPONENT_SIZE',
          payload: { key: msg.payload.key, width: comp.width, height: comp.height },
        });
      }
      break;
    }

    case 'RUN_SYNC': {
      try {
        await runSync(msg.payload as RunSyncPayload);
      } catch (err: any) {
        sendProgress(`Fatal error: ${err.message || err}`, 'error');
        figma.ui.postMessage({ type: 'SYNC_COMPLETE', payload: { cardCounts: {}, totalCards: 0 } });
      }
      break;
    }

    case 'EXPORT_PRINTS': {
      try {
        await exportPrintFrames();
      } catch (err: any) {
        sendProgress(`Export error: ${err.message || err}`, 'error');
        figma.ui.postMessage({ type: 'EXPORT_COMPLETE', payload: null });
      }
      break;
    }

    case 'EXPORT_TTS': {
      try {
        await exportTtsDecks();
      } catch (err: any) {
        sendProgress(`TTS export error: ${err.message || err}`, 'error');
        figma.ui.postMessage({ type: 'EXPORT_TTS_COMPLETE', payload: null });
      }
      break;
    }
  }
};

// ---------------------------------------------------------------------------
// Export Print Frames
// ---------------------------------------------------------------------------

/**
 * Validate and clean up a frame before export to prevent runtime aborts.
 * Removes detached nodes, validates all child nodes, and cleans up instances.
 */
async function validateAndCleanFrame(frame: FrameNode): Promise<boolean> {
  try {
    // Check if frame is still valid and attached
    if (frame.removed || !frame.parent) {
      return false;
    }

    // Find and detach any remaining instances (this prevents component reference errors)
    const instances = frame.findAll((n) => n.type === 'INSTANCE') as InstanceNode[];
    for (const inst of instances) {
      try {
        inst.detachInstance();
      } catch {
        // Can't detach, might already be detached
      }
    }

    // Remove any detached children
    const children = [...frame.children];
    for (const child of children) {
      try {
        // Try to access basic properties to verify the node is valid
        const _ = child.name;
        const __ = child.type;

        if (child.removed) {
          continue; // Skip already removed nodes
        }
      } catch (e) {
        // Node is invalid, try to remove it
        try {
          child.remove();
        } catch (removeErr) {
          // Can't remove, frame might be corrupted
          return false;
        }
      }
    }

    // Clean up any problematic image fills
    const nodesWithFills = frame.findAll((n) => 'fills' in n);
    for (const node of nodesWithFills) {
      try {
        const fills = (node as GeometryMixin).fills;
        if (fills !== figma.mixed && Array.isArray(fills)) {
          const validFills = fills.filter((fill) => {
            if (fill.type === 'IMAGE') {
              try {
                return fill.imageHash !== undefined && fill.imageHash !== null;
              } catch {
                return false;
              }
            }
            return true;
          });
          if (validFills.length !== fills.length) {
            (node as GeometryMixin).fills = validFills;
          }
        }
      } catch {
        // If we can't access fills, set to empty
        try {
          (node as GeometryMixin).fills = [];
        } catch {
          // Can't fix this node
        }
      }
    }

    return true;
  } catch (e) {
    return false;
  }
}

async function exportPrintFrames() {
  const printFrames = figma.currentPage.children.filter(
    (n): n is FrameNode => n.type === 'FRAME' && n.name.startsWith('Print --')
  );

  if (printFrames.length === 0) {
    sendProgress('No print frames found. Run Sync & Build first.', 'error');
    figma.ui.postMessage({ type: 'EXPORT_COMPLETE', payload: null });
    return;
  }

  sendProgress('Validating and cleaning print frames...');

  // Validate all frames before starting export
  let invalidFrames = 0;
  let cleanedFrames = 0;
  for (const frame of printFrames) {
    const isValid = await validateAndCleanFrame(frame);
    if (!isValid) {
      sendProgress(`Warning: Frame "${frame.name}" has invalid nodes`, 'warn');
      invalidFrames++;
    } else {
      cleanedFrames++;
    }
  }

  sendProgress(`Validated ${cleanedFrames} frames successfully${invalidFrames > 0 ? `, cleaned ${invalidFrames} frames with issues` : ''}`);

  printFrames.sort((a, b) => a.name.localeCompare(b.name));

  const groups: { [key: string]: FrameNode[] } = {};
  for (const frame of printFrames) {
    const parts = frame.name.split(' -- ');
    if (parts.length >= 3) {
      const groupKey = (parts[1] + '_' + parts[2]).toLowerCase();
      if (!groups[groupKey]) groups[groupKey] = [];
      groups[groupKey].push(frame);
    }
  }

  const groupKeys = Object.keys(groups).sort();
  sendProgress(`Exporting ${groupKeys.length} PDFs (${printFrames.length} total pages)...`);

  for (const groupKey of groupKeys) {
    const frames = groups[groupKey];

    // CRITICAL: Backs must be in the SAME page order as fronts (01, 02, 03...),
    // NOT reversed, because the printer prints last-to-first AND you flip the
    // physical stack when reloading (two reversals cancel out).
    // Sort within each group to ensure correct order:
    frames.sort((a, b) => a.name.localeCompare(b.name));

    sendProgress(`Exporting ${groupKey}.pdf (${frames.length} pages)...`);

    let pagesSent = 0;
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      try {
        sendProgress(`  Rendering ${frame.name}...`);

        // Pre-load all fonts in the frame to avoid runtime issues
        const textNodes = frame.findAll((n) => n.type === 'TEXT') as TextNode[];
        for (const tn of textNodes) {
          const len = tn.characters.length;
          if (len > 0) {
            try {
              for (const font of tn.getRangeAllFontNames(0, len)) {
                await figma.loadFontAsync(font);
              }
            } catch (fontErr: any) {
              sendProgress(`    Warning: Could not load font for text in ${frame.name}`, 'warn');
            }
          } else if (tn.fontName !== figma.mixed) {
            try {
              await figma.loadFontAsync(tn.fontName as FontName);
            } catch (fontErr: any) {
              sendProgress(`    Warning: Could not load font for text in ${frame.name}`, 'warn');
            }
          }
        }

        // Use scale 2 instead of 3 to reduce memory usage and prevent crashes
        const pngBytes = await frame.exportAsync({
          format: 'PNG',
          constraint: { type: 'SCALE', value: 2 },
        });
        // Ship each page to the UI immediately as a Uint8Array. Converting to a
        // plain number[] and batching whole groups makes the plugin bridge
        // deep-unwrap millions of boxed Numbers at once, which aborts the
        // sandbox VM on large exports.
        figma.ui.postMessage({
          type: 'EXPORT_PDF_PAGE',
          payload: {
            filename: groupKey + '.pdf',
            bytes: pngBytes,
            pageWidth: 612,
            pageHeight: 792,
          },
        });
        pagesSent++;
        sendProgress(`  Rendered page ${pagesSent}/${frames.length}`);
      } catch (err: any) {
        sendProgress(`ERROR exporting frame "${frame.name}": ${err.message || err}`, 'error');
        sendProgress(`Skipping this frame and continuing...`, 'warn');
        // Continue with next frame instead of aborting entire export
      }
    }

    if (pagesSent === 0) {
      sendProgress(`No pages successfully exported for ${groupKey}.pdf`, 'error');
    }
  }

  sendProgress(`Export complete — ${groupKeys.length} PDFs.`);
  figma.ui.postMessage({ type: 'EXPORT_COMPLETE', payload: null });
}

// ---------------------------------------------------------------------------
// Export for Tabletop Simulator
// ---------------------------------------------------------------------------
//
// TTS builds a "custom deck" from a single stitched sheet image: a tight grid
// of card faces (≤10 wide × 7 tall = 70 per sheet), plus a matching sheet of
// backs. We always emit unique backs (one back per card, same grid + order) so
// there's a single code path — if the backs happen to be identical, TTS is none
// the wiser. FaceURL/BackURL must be hosted URLs, so we can't produce a
// self-contained file; instead we ship the sheet PNGs and a README telling the
// user to feed them into TTS's in-game Custom Deck wizard (which uploads to
// Steam Cloud and fills the URLs).
//
// Source of card art: the persistent `Print -- <Tab> -- Fronts/Backs -- NN`
// frames left on the canvas by the sync run. The working `<Tab> Fronts/Backs`
// frames are removed at the end of sync, so the Print frames are the only
// persistent per-card render. Each card there is a detached frame still named
// after its card (`row.name`), and fronts/backs share those names — so we pair
// fronts↔backs by node name and lay them out in alphabetical (deck) order,
// independent of the print grid's layout or its back-side row mirroring.

const TTS_MAX_PER_SHEET = 70; // 10 cols × 7 rows — TTS practical maximum
const TTS_MAX_COLS = 10;
const TTS_MAX_DIM = 4096; // keep each sheet texture ≤ 4096px per axis (TTS guideline)
const TTS_MAX_SCALE = 2; // matches the PDF path; caps memory on big exports

interface TtsSheetSpec {
  frame: FrameNode;
  cols: number;
  rows: number;
  count: number;
}

/** Sanitize a tab name into a filename-safe slug. */
function ttsFileSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'deck';
}

/** Collect the detached card nodes from a card type's Print frames for one side,
 *  in sheet order (01, 02, …) then child order within each sheet. */
function gatherPrintCards(tabName: string, side: 'Fronts' | 'Backs'): SceneNode[] {
  const prefix = `Print -- ${tabName} -- ${side} -- `;
  const frames = figma.currentPage.children.filter(
    (n): n is FrameNode => n.type === 'FRAME' && n.name.startsWith(prefix)
  );
  frames.sort((a, b) => a.name.localeCompare(b.name));
  const cards: SceneNode[] = [];
  for (const f of frames) {
    for (const child of f.children) cards.push(child);
  }
  return cards;
}

/** Grid dimensions for a sheet of `n` cards (row-major, ≤10 wide, ≤70 total).
 *  TTS's Custom Deck wizard enforces a MINIMUM of 2 for both Width and Height —
 *  a 1-row (or 1-column) sheet gets sliced into 2, cutting every card in half.
 *  So we rebalance any single-row layout into at least 2 rows, and clamp both
 *  dimensions to ≥ 2. Unused trailing cells are fine (Number of cards bounds it). */
function ttsGrid(n: number): { cols: number; rows: number } {
  let cols = Math.min(TTS_MAX_COLS, n);
  let rows = Math.ceil(n / cols);

  // Small decks (n ≤ 10) would otherwise be a single row — reshape to 2 rows.
  if (rows < 2) {
    cols = Math.min(TTS_MAX_COLS, Math.ceil(n / 2));
    rows = Math.ceil(n / cols);
  }

  // Guarantee both dimensions clear TTS's minimum of 2.
  cols = Math.max(2, cols);
  rows = Math.max(2, rows);
  return { cols, rows };
}

/** Build tight, margin-free grid frames (one per ≤70-card chunk) from card nodes.
 *  Entries in `nodes` may be null (a card with no matching back) → blank cell,
 *  which keeps face and back grids index-aligned. Frames are placed off-canvas;
 *  exportAsync renders each frame's own subtree, so their positions don't matter. */
function buildTtsSheets(
  tabName: string,
  side: 'Faces' | 'Backs',
  nodes: (SceneNode | null)[],
  cardW: number,
  cardH: number
): TtsSheetSpec[] {
  const specs: TtsSheetSpec[] = [];
  let sheetNumber = 1;

  for (let start = 0; start < nodes.length; start += TTS_MAX_PER_SHEET) {
    const chunk = nodes.slice(start, start + TTS_MAX_PER_SHEET);
    const { cols, rows } = ttsGrid(chunk.length);

    const frame = figma.createFrame();
    frame.name = `TTS -- ${tabName} -- ${side} -- ${String(sheetNumber).padStart(2, '0')}`;
    frame.resize(cols * cardW, rows * cardH);
    frame.x = -10000;
    frame.y = 0;
    frame.clipsContent = true;
    frame.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];

    for (let i = 0; i < chunk.length; i++) {
      const node = chunk[i];
      if (!node) continue; // leave the cell blank
      try {
        const clone = node.clone();
        clone.x = (i % cols) * cardW;
        clone.y = Math.floor(i / cols) * cardH;
        frame.appendChild(clone);
      } catch (err: any) {
        sendProgress(`  Warning: could not place card ${i + 1} on ${side} sheet: ${err.message || err}`, 'warn');
      }
    }

    specs.push({ frame, cols, rows, count: chunk.length });
    sheetNumber++;
  }

  return specs;
}

/** Render one TTS grid frame to PNG and ship it to the UI. Scale is chosen so
 *  neither axis exceeds TTS_MAX_DIM, capped at TTS_MAX_SCALE. */
async function exportTtsFrame(frame: FrameNode, filename: string): Promise<boolean> {
  // Reload fonts defensively — in a fresh session the Print-frame text may not
  // have its fonts loaded yet, which would render fallback glyphs (same guard
  // the PDF path uses).
  const textNodes = frame.findAll((n) => n.type === 'TEXT') as TextNode[];
  for (const tn of textNodes) {
    const len = tn.characters.length;
    try {
      if (len > 0) {
        for (const font of tn.getRangeAllFontNames(0, len)) await figma.loadFontAsync(font);
      } else if (tn.fontName !== figma.mixed) {
        await figma.loadFontAsync(tn.fontName as FontName);
      }
    } catch {
      // Non-fatal; keep going and let export render what it can.
    }
  }

  const w = frame.width;
  const h = frame.height;
  let scale = Math.min(TTS_MAX_SCALE, TTS_MAX_DIM / w, TTS_MAX_DIM / h);
  if (!(scale > 0)) scale = 1;

  try {
    sendProgress(`  Rendering ${filename} (${Math.round(w * scale)}×${Math.round(h * scale)}px)...`);
    const pngBytes = await frame.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: scale } });
    figma.ui.postMessage({ type: 'EXPORT_TTS_SHEET', payload: { filename, bytes: pngBytes } });
    return true;
  } catch (err: any) {
    sendProgress(`ERROR exporting ${filename}: ${err.message || err}`, 'error');
    return false;
  }
}

/** Escape a string for embedding inside a double-quoted Lua literal. */
function luaEscape(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

/** Build a paste-in Lua tagging script for one loaded deck (one sheet), or null
 *  if none of its cards carry metadata. `cards` are the deck's cards in order;
 *  `meta` maps card name → {name, desc}. The script adds a right-click item that
 *  reads the deck's own data (image URLs already baked in by the wizard),
 *  writes Nickname/Description per card by position, and respawns the deck. */
function buildTtsMetadataLua(
  tab: string,
  sheetLabel: string,
  cards: SceneNode[],
  meta: { [cardName: string]: { name?: string; desc?: string } }
): string | null {
  const entries: string[] = [];
  for (let i = 0; i < cards.length; i++) {
    const m = meta[cards[i].name];
    if (!m || (!m.name && !m.desc)) continue;
    const parts: string[] = [];
    if (m.name) parts.push(`name = "${luaEscape(m.name)}"`);
    if (m.desc) parts.push(`desc = "${luaEscape(m.desc)}"`);
    // Lua tables are 1-indexed, matching ipairs over ContainedObjects.
    entries.push(`  [${i + 1}] = { ${parts.join(', ')} },`);
  }
  if (entries.length === 0) return null;

  return `-- Card metadata for "${tab}" (sheet ${sheetLabel}) — generated by Figma Card Importer.
-- HOW TO USE:
--   1. Import this sheet's -faces-/-backs- PNGs as a deck (Custom > Deck).
--   2. Right-click the deck > Scripting, paste this whole file, then Save & Play.
--   3. Right-click the deck > "Apply card metadata" (one time).
-- Names are searchable via the deck's Search; descriptions show on hover.
-- Run it on the freshly loaded, unshuffled deck so positions line up.

local META = {
${entries.join('\n')}
}

function onLoad()
  self.addContextMenuItem("Apply card metadata", applyMeta)
end

function applyMeta()
  local data = self.getData()
  local objs = data.ContainedObjects
  if not objs then
    broadcastToAll("Run this on a deck (2+ cards), not a single card.", {1, 0.3, 0.3})
    return
  end
  local tagged = 0
  for i, card in ipairs(objs) do
    local m = META[i]
    if m then
      if m.name then card.Nickname = m.name end
      if m.desc then card.Description = m.desc end
      tagged = tagged + 1
    end
  end
  local pos, rot, scale = self.getPosition(), self.getRotation(), self.getScale()
  self.destruct()
  spawnObjectData({ data = data, position = pos, rotation = rot, scale = scale })
  broadcastToAll("Applied metadata to " .. tagged .. " cards.", {0.3, 1, 0.3})
end
`;
}

async function exportTtsDecks() {
  // Discover card types from the persistent Print -- <Tab> -- Fronts -- NN frames.
  const frontFrames = figma.currentPage.children.filter(
    (n): n is FrameNode => n.type === 'FRAME' && /^Print -- .+ -- Fronts -- \d+$/.test(n.name)
  );

  if (frontFrames.length === 0) {
    sendProgress('No print frames found. Run Sync & Build first.', 'error');
    figma.ui.postMessage({ type: 'EXPORT_TTS_COMPLETE', payload: null });
    return;
  }

  // Report how many Print frames we can see, split by side, so a stale/partial
  // canvas (e.g. fronts but no backs) is obvious in the log.
  const allPrintFrames = figma.currentPage.children.filter(
    (n): n is FrameNode => n.type === 'FRAME' && n.name.indexOf('Print --') === 0
  );
  const backCount = allPrintFrames.filter((f) => f.name.indexOf(' -- Backs -- ') !== -1).length;
  sendProgress(`Found ${allPrintFrames.length} Print frame(s): ${frontFrames.length} fronts, ${backCount} backs.`);

  const tabNames: string[] = [];
  for (const f of frontFrames) {
    const parts = f.name.split(' -- ');
    if (parts.length >= 4 && tabNames.indexOf(parts[1]) === -1) tabNames.push(parts[1]);
  }
  tabNames.sort();

  const readme: string[] = [
    'TABLETOP SIMULATOR — DECK IMPORT',
    '=================================',
    '',
    '  *** CRITICAL: TTS defaults the Width x Height to 10 x 7. That is almost',
    '  *** never right for these sheets. You MUST change Width and Height to the',
    '  *** exact values shown for each sheet below (also baked into every',
    '  *** filename, e.g. "..._10x6_" means Width=10, Height=6). If you leave the',
    '  *** 10x7 default, the cards will drift/misalign further down the deck.',
    '',
    'These are stitched card sheets (faces + matching backs). For each deck:',
    '',
    '  1. In TTS: Objects > Components > Custom > Deck',
    '  2. Face  = the "-faces-" PNG   Back = the "-backs-" PNG',
    '     (when asked, choose Cloud upload so TTS hosts the image and fills the URL)',
    '  3. Set Width and Height to the EXACT grid values shown below (NOT 10x7)',
    '  4. Set Number of cards to the count shown',
    '  5. Turn ON "Unique Backs" and "Back is Hidden"',
    '  6. Click the load/confirm button.',
    '',
    'Sheets hold up to 70 cards (10x7 max); decks larger than that are split into',
    'multiple numbered sheets — load each as its own deck (or merge in-game).',
    '',
    '---------------------------------',
    '',
  ];

  // Load per-card TTS metadata harvested at sync time (may be empty).
  let ttsMetaAll: { [tab: string]: { [cardName: string]: { name?: string; desc?: string } } } = {};
  try {
    const raw = figma.root.getPluginData('cardSyncTtsMeta');
    if (raw) ttsMetaAll = JSON.parse(raw);
  } catch {
    ttsMetaAll = {};
  }

  const tempFrames: FrameNode[] = [];
  let anySheets = false;
  let scriptCount = 0;

  for (const tab of tabNames) {
    // Gather order is already sheet order: the front print frames were built
    // from sheet-ordered instances, and gatherPrintCards preserves frame (01,
    // 02, …) then child append order. Backs are paired by name below, so they
    // inherit this same order regardless of the print frames' row-mirroring.
    const fronts = gatherPrintCards(tab, 'Fronts');
    if (fronts.length === 0) continue;

    const backsRaw = gatherPrintCards(tab, 'Backs');
    if (backsRaw.length === 0) {
      sendProgress(`"${tab}": no back print frames — skipping TTS deck (backs are required).`, 'warn');
      continue;
    }

    // Pair each front with its back by node name; deck order = fronts alphabetical.
    const backMap = new Map<string, SceneNode>();
    for (const b of backsRaw) if (!backMap.has(b.name)) backMap.set(b.name, b);

    const orderedBacks: (SceneNode | null)[] = [];
    let missingBacks = 0;
    for (const f of fronts) {
      const b = backMap.get(f.name) || null;
      if (!b) missingBacks++;
      orderedBacks.push(b);
    }
    if (missingBacks > 0) {
      sendProgress(`"${tab}": ${missingBacks} card(s) had no matching back — those back cells left blank.`, 'warn');
    }

    const fW = fronts[0].width;
    const fH = fronts[0].height;
    const bW = backsRaw[0].width;
    const bH = backsRaw[0].height;

    sendProgress(`Building TTS sheets for "${tab}" (${fronts.length} cards)...`);

    const faceSpecs = buildTtsSheets(tab, 'Faces', fronts, fW, fH);
    const backSpecs = buildTtsSheets(tab, 'Backs', orderedBacks, bW, bH);
    for (const s of faceSpecs) tempFrames.push(s.frame);
    for (const s of backSpecs) tempFrames.push(s.frame);

    const slug = ttsFileSlug(tab);
    const tabMeta = ttsMetaAll[tab] || null;
    readme.push(`Deck: ${tab}  —  ${fronts.length} card(s), ${faceSpecs.length} sheet(s)`);

    let cursor = 0; // running index into the sheet-ordered fronts
    for (let s = 0; s < faceSpecs.length; s++) {
      const fs = faceSpecs[s];
      const bs = backSpecs[s];
      const num = String(s + 1).padStart(2, '0');
      // Bake the grid + card count into every filename so the exact TTS
      // values (Width x Height, Number) are impossible to miss.
      const dims = `${fs.cols}x${fs.rows}_${fs.count}cards`;
      const faceName = `${slug}-faces-${num}_${dims}.png`;
      const backName = `${slug}-backs-${num}_${dims}.png`;

      const sheetCards = fronts.slice(cursor, cursor + fs.count);
      cursor += fs.count;

      const okFace = await exportTtsFrame(fs.frame, faceName);
      const okBack = bs ? await exportTtsFrame(bs.frame, backName) : false;
      if (okFace) anySheets = true;

      readme.push(`  Sheet ${num}: ${faceName}${okBack ? ` + ${backName}` : ''}`);
      readme.push(`    >>> Width=${fs.cols}  Height=${fs.rows}  Number=${fs.count}  (Unique Backs ON, Back is Hidden ON)`);

      // Emit a per-deck Lua tagging script when metadata is present.
      if (tabMeta) {
        const lua = buildTtsMetadataLua(tab, num, sheetCards, tabMeta);
        if (lua) {
          const scriptName = `${slug}-${num}.lua`;
          figma.ui.postMessage({ type: 'EXPORT_TTS_SCRIPT', payload: { filename: scriptName, text: lua } });
          scriptCount++;
          readme.push(`    metadata script: ${scriptName} (paste into the deck's Object script, then right-click > Apply card metadata)`);
        }
      }
    }
    readme.push('');
  }

  // Remove the temporary grid frames now that they've been rendered.
  for (const f of tempFrames) {
    try {
      f.remove();
    } catch {
      // already gone
    }
  }

  if (!anySheets) {
    sendProgress('No TTS sheets exported.', 'error');
    figma.ui.postMessage({ type: 'EXPORT_TTS_COMPLETE', payload: null });
    return;
  }

  if (scriptCount > 0) {
    readme.push('---------------------------------');
    readme.push('');
    readme.push('SEARCHABLE CARD METADATA (.lua files)');
    readme.push('Each deck above has a matching .lua script. After loading a deck:');
    readme.push('  1. Right-click the deck > Scripting, paste the matching .lua, Save & Play.');
    readme.push('  2. Right-click the deck > "Apply card metadata".');
    readme.push('Cards then carry searchable names (deck Search) + hover descriptions.');
    readme.push('Run it on the freshly loaded, unshuffled deck so positions line up.');
    readme.push('');
  }

  figma.ui.postMessage({ type: 'EXPORT_TTS_README', payload: { text: readme.join('\n') } });
  sendProgress(`TTS export complete${scriptCount > 0 ? ` — ${scriptCount} metadata script(s) included` : ''}.`);
  figma.ui.postMessage({ type: 'EXPORT_TTS_COMPLETE', payload: null });
}
