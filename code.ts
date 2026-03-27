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

  for (const row of rows) {
    const key = row.name.toLowerCase();
    let instance = existing.get(key);
    if (!instance) {
      instance = component.createInstance();
      frame.appendChild(instance);
      sendProgress(`Created ${side} instance for "${row.name}"`);
    }
    instance.name = row.name;
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
    const fieldName = node.name.substring(node.name.indexOf('#') + 1).toLowerCase();

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
// Sort Instances Alphabetically
// ---------------------------------------------------------------------------

function sortAndLayoutInstances(frame: FrameNode, cardWidth: number, cardHeight: number) {
  const instances = frame.children
    .filter((n): n is InstanceNode => n.type === 'INSTANCE')
    .sort((a, b) => a.name.localeCompare(b.name));

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
        const clone = instances[cardIndex].clone();
        const col = mirrorRows ? (cols - 1 - c) : c;
        clone.x = offsetX + col * (cardWidth + gapX);
        clone.y = offsetY + r * (cardHeight + gapY);
        sheetFrame.appendChild(clone);
        cardIndex++;
      }
    }

    sheets.push(sheetFrame);
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
            const fieldName = tn.name.substring(tn.name.indexOf('#') + 1).toLowerCase();
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
    sendProgress(`Sorting "${ct.tabName}" alphabetically...`);
    sortAndLayoutInstances(frontsFrame, cardWidth, cardHeight);
    if (backsFrame) sortAndLayoutInstances(backsFrame, cardWidth, cardHeight);

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
      .sort((a, b) => a.name.localeCompare(b.name));

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
        .sort((a, b) => a.name.localeCompare(b.name));

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
      const settings = await figma.clientStorage.getAsync('cardSyncSettings');
      figma.ui.postMessage({ type: 'SETTINGS', payload: settings || null });
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
      await figma.clientStorage.setAsync('cardSyncSettings', msg.payload);
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
  }
};

// ---------------------------------------------------------------------------
// Export Print Frames
// ---------------------------------------------------------------------------

async function exportPrintFrames() {
  const printFrames = figma.currentPage.children.filter(
    (n): n is FrameNode => n.type === 'FRAME' && n.name.startsWith('Print --')
  );

  if (printFrames.length === 0) {
    sendProgress('No print frames found. Run Sync & Build first.', 'error');
    figma.ui.postMessage({ type: 'EXPORT_COMPLETE', payload: null });
    return;
  }

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
    sendProgress(`Exporting ${groupKey}.pdf (${frames.length} pages)...`);

    const pngPages: number[][] = [];
    for (const frame of frames) {
      const pngBytes = await frame.exportAsync({
        format: 'PNG',
        constraint: { type: 'SCALE', value: 3 },
      });
      pngPages.push(Array.from(pngBytes));
      sendProgress(`  Rendered page ${pngPages.length}/${frames.length}`);
    }

    figma.ui.postMessage({
      type: 'EXPORT_PDF_GROUP',
      payload: {
        filename: groupKey + '.pdf',
        pages: pngPages,
        pageWidth: 612,
        pageHeight: 792,
      },
    });
  }

  sendProgress(`Export complete — ${groupKeys.length} PDFs.`);
  figma.ui.postMessage({ type: 'EXPORT_COMPLETE', payload: null });
}
