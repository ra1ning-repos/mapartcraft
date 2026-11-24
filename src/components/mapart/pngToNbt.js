// Schematic (.nbt) generation through EvModder's PNG-to-NBT: https://evmodder.net/PNG-to-NBT/
//
// api.js is loaded straight from evmodder.net (it must never be bundled) and runs the generator in a hidden
// iframe from that site, inside the visitor's own browser. Each call builds one 128x128 map.

import { gzip, ungzip } from "pako";

export const PNG_TO_NBT_SITE_URL = "https://evmodder.net/PNG-to-NBT/";
const PNG_TO_NBT_API_URL = "https://evmodder.net/PNG-to-NBT/api.js";

// MapartCraft version -> PNG-to-NBT's minecraftVersion key. PNG-to-NBT starts at 1.21.4; a version that is
// not listed here keeps MapartCraft's built-in generator. From 26.3 on, Minecraft calls the block-state
// fields of a structure palette {id, properties} instead of {Name, Properties}, and PNG-to-NBT writes
// whichever its version key implies. Newer versions are therefore asked for the 26.2 format: the game
// upgrades it when the structure loads, and older tools can still read it.
const VERSION_KEYS = {
  "1.21.4": "1.21.4",
  "1.21.5": "1.21.5",
  "1.21.6": "1.21.5",
  "1.21.7": "1.21.5",
  "1.21.8": "1.21.5",
  "1.21.9": "1.21.9",
  "1.21.10": "1.21.9",
  "1.21.11": "1.21.9",
  "26.1": "1.21.9",
  "26.1.1": "1.21.9",
  "26.1.2": "1.21.9",
  "26.2": "26.2",
  "26.3": "26.2",
  "26.4": "26.2",
};

export function pngToNbtVersionKey(mcVersion) {
  return VERSION_KEYS[mcVersion] || null;
}

export function usesPngToNbt(optionValue_version) {
  return pngToNbtVersionKey(optionValue_version.MCVersion) !== null;
}

// ---------------------------------------------------------------- options shown in Schematic options

const SHADING = "MAP-SETTINGS/SCHEMATIC/SHADING-METHOD/";
// legacy: also offered by the built-in generator used for versions PNG-to-NBT does not cover
export const SHADING_METHOD_GROUPS = [
  {
    localeKey: `${SHADING}STAIRCASE`,
    methods: [
      { value: "staircase_northline", localeKey: `${SHADING}NORTHLINE` },
      { value: "staircase_southline", localeKey: `${SHADING}SOUTHLINE` },
      { value: "staircase_classic", localeKey: `${SHADING}CLASSIC`, legacy: true },
      { value: "staircase_valley", localeKey: `${SHADING}VALLEY`, legacy: true },
      { value: "staircase_group", localeKey: `${SHADING}GROUP` },
      { value: "staircase_party", localeKey: `${SHADING}PARTY` },
    ],
  },
  {
    localeKey: `${SHADING}SUPPRESS`,
    methods: [
      { value: "suppress_step_pairs", localeKey: `${SHADING}STEPS-PAIRS` },
      { value: "suppress_step_checker", localeKey: `${SHADING}STEPS-CHECKER` },
      { value: "suppress_2layer", localeKey: `${SHADING}2-LAYER` },
    ],
  },
];

export const LATE_SHADING_MODES = [
  { value: "suppress_2layer_late_fillers", localeKey: "MAP-SETTINGS/SCHEMATIC/LATE-SHADING/LATE-FILLERS" },
  { value: "suppress_2layer_late_pairs", localeKey: "MAP-SETTINGS/SCHEMATIC/LATE-SHADING/LATE-PAIRS" },
];

// legacy: the "Add blocks under" mode the built-in generator uses for it (also used for the materials estimate)
export const SUPPORT_MODES = [
  { value: "none", localeKey: "MAP-SETTINGS/SCHEMATIC/SUPPORT/NONE", legacy: "NONE" },
  { value: "steps", localeKey: "MAP-SETTINGS/SCHEMATIC/SUPPORT/STEPS", legacy: "ALL_OPTIMIZED" },
  { value: "all", localeKey: "MAP-SETTINGS/SCHEMATIC/SUPPORT/ALL", legacy: "ALL_DOUBLE_OPTIMIZED" },
  { value: "fragile", localeKey: "MAP-SETTINGS/SCHEMATIC/SUPPORT/FRAGILE", legacy: "IMPORTANT" },
  { value: "water", localeKey: "MAP-SETTINGS/SCHEMATIC/SUPPORT/WATER", legacy: null },
];

export const SUPPRESSION_DIRECTIONS = [
  { value: "east_to_west", localeKey: "MAP-SETTINGS/SCHEMATIC/SUPPRESSION-DIRECTION/EAST-TO-WEST" },
  { value: "west_to_east", localeKey: "MAP-SETTINGS/SCHEMATIC/SUPPRESSION-DIRECTION/WEST-TO-EAST" },
  { value: "north_to_south", localeKey: "MAP-SETTINGS/SCHEMATIC/SUPPRESSION-DIRECTION/NORTH-TO-SOUTH" },
  { value: "south_to_north", localeKey: "MAP-SETTINGS/SCHEMATIC/SUPPRESSION-DIRECTION/SOUTH-TO-NORTH" },
];

// The order PNG-to-NBT itself moves on to the next direction in.
const DIRECTION_CYCLE = ["west_to_east", "north_to_south", "east_to_west", "south_to_north"];

export const SCHEMATIC_DEFAULTS = {
  shadingMethod: "staircase_classic",
  lateShading: "suppress_2layer_late_fillers",
  layerGap: 5,
  latePairsGap: 1,
  crubTech: false,
  support: "steps",
  supportBlock: "cobblestone",
  shadeBlock: "resin_block",
  crubTechPushableBlock: "resin_block",
  suppressDirection: "east_to_west",
  suppressOneDirection: true,
  keepReusableBlocks: true,
  blockRecycling: true,
};

// The largest layer gap offered, as on PNG-to-NBT's site (its API would take up to 63).
export const MAX_LAYER_GAP = 20;

// CrubTech builds for one specific 2-layer platform, so PNG-to-NBT fixes these for it: the layer spacing,
// east-to-west in one direction, support either none or under everything, late pairs for late shading, and
// moss as the breakable block (only the pushable one can be chosen).
export const CRUBTECH = {
  layerGap: 14,
  latePairsGap: 10,
  suppressDirection: "east_to_west",
  lateShading: "suppress_2layer_late_pairs",
};

export function isSuppressMethod(method) {
  return method.startsWith("suppress_");
}

export function isStepsMethod(method) {
  return method === "suppress_step_pairs" || method === "suppress_step_checker";
}

export function findShadingMethod(method) {
  for (const group of SHADING_METHOD_GROUPS) {
    const found = group.methods.find((entry) => entry.value === method);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

// The built-in generator only knows Classic and Valley, and builds anything else as Classic.
export function legacyShadingMethod(method) {
  return method === "staircase_valley" ? method : "staircase_classic";
}

// The built-in generator has no water mode; it builds that as no support.
export function legacySupportMode(support) {
  const mode = SUPPORT_MODES.find((entry) => entry.value === support);
  return mode !== undefined && mode.legacy !== null ? support : "none";
}

// Under CrubTech, any support at all means support under everything.
export function crubTechSupportMode(support) {
  return support === "none" ? "none" : "all";
}

// The 2-Layer spacing actually used, following PNG-to-NBT: Fragile and All support need a gap of at least 3,
// and the late pairs have to stay below the build limit. PNG-to-NBT can raise the gap further for a map
// whose blocks need more room.
export function twoLayerSpacing(support, layerGap, latePairsGap, crubTech) {
  const minLayerGap = support === "fragile" || support === "all" ? 3 : 2;
  if (crubTech) {
    return { minLayerGap, layerGap: CRUBTECH.layerGap, maxLatePairsGap: 64 - CRUBTECH.layerGap, latePairsGap: CRUBTECH.latePairsGap };
  }
  const gap = Math.min(MAX_LAYER_GAP, Math.max(minLayerGap, layerGap));
  const maxLatePairsGap = 64 - gap;
  return { minLayerGap, layerGap: gap, maxLatePairsGap, latePairsGap: Math.max(1, Math.min(maxLatePairsGap, latePairsGap)) };
}

// Key into whereSupportBlocksModes.json for a support mode.
export function legacyWhereSupportBlocksKey(support) {
  return SUPPORT_MODES.find((entry) => entry.value === legacySupportMode(support)).legacy;
}

// ---------------------------------------------------------------- blocks and colours

function cleanBlockName(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/^minecraft:/, "")
    .replace(/\s+/g, "_");
}

// A block as PNG-to-NBT's catalog spells it: "minecraft:name[key=value,...]", keys sorted. MapartCraft's list
// matches it except for default states it writes out (vertical logs are axis=y, iron trapdoors half=bottom),
// and grindstones, which PNG-to-NBT only takes standing on the floor.
export function pngToNbtBlockState(nbtName, nbtArgs = {}) {
  const name = cleanBlockName(nbtName);
  const props = {};
  for (const [key, value] of Object.entries(nbtArgs)) {
    props[key.trim()] = String(value).trim();
  }
  if (props.axis === "y") {
    delete props.axis;
  }
  if (name === "iron_trapdoor" && props.half === "bottom") {
    delete props.half;
  }
  if (name === "grindstone" && props.face === undefined) {
    props.face = "floor";
  }
  const keys = Object.keys(props).sort();
  return keys.length === 0 ? `minecraft:${name}` : `minecraft:${name}[${keys.map((key) => `${key}=${props[key]}`).join(",")}]`;
}

function blockNBTData(block, mcVersion) {
  let data = block.validVersions[mcVersion];
  if (typeof data === "string") {
    data = block.validVersions[data.slice(1)]; // of the form "&1.12.2"
  }
  return data;
}

// The block PNG-to-NBT gets for every colour set used, keyed by Minecraft base colour id.
export function pngToNbtBlocks(usedColourSetIds, coloursJSON, selectedBlocks, mcVersion) {
  const blocks = {};
  for (const colourSetId of usedColourSetIds) {
    const colourSet = coloursJSON[colourSetId];
    const blockId = selectedBlocks[colourSetId];
    if (blockId === undefined || blockId === "-1") {
      continue;
    }
    const data = blockNBTData(colourSet.blocks[blockId], mcVersion);
    blocks[colourSet.mapdatId] = pngToNbtBlockState(data.NBTName, data.NBTArgs);
  }
  return blocks;
}

const TONE_SHADES = { dark: 0, normal: 1, light: 2, unobtainable: 3 };

// Exact preview RGB -> colour set and map shade. Every tone colour in coloursJSON is unique.
export function exactColourLookup(coloursJSON) {
  const lookup = new Map();
  for (const [colourSetId, colourSet] of Object.entries(coloursJSON)) {
    for (const [toneKey, rgb] of Object.entries(colourSet.tonesRGB)) {
      lookup.set((rgb[0] << 16) + (rgb[1] << 8) + rgb[2], { colourSetId, mapdatId: colourSet.mapdatId, shade: TONE_SHADES[toneKey] });
    }
  }
  return lookup;
}

// One map of the preview as Minecraft map bytes (base colour * 4 + shade, row by row from the north), and the
// colour sets it uses. Transparent pixels (Air) are byte 0.
export function mapTileColours(pixelsData, mapsWide, whichMap_x, whichMap_y, lookup) {
  const colors = new Uint8Array(128 * 128);
  const used = new Set();
  for (let z = 0; z < 128; z++) {
    let offset = 4 * (128 * mapsWide * (128 * whichMap_y + z) + 128 * whichMap_x);
    for (let x = 0; x < 128; x++, offset += 4) {
      if (pixelsData[offset + 3] === 0) {
        continue;
      }
      const entry = lookup.get((pixelsData[offset] << 16) + (pixelsData[offset + 1] << 8) + pixelsData[offset + 2]);
      if (entry === undefined || entry.shade > 2) {
        throw Object.assign(new Error(`Unexpected preview colour at ${x},${z}`), { code: "UNKNOWN_COLOUR" });
      }
      colors[z * 128 + x] = 4 * entry.mapdatId + entry.shade;
      used.add(entry.colourSetId);
    }
  }
  return { colors, used };
}

// ---------------------------------------------------------------- generation

// CrubTech only applies to 2-Layer builds.
export function usesCrubTech(settings) {
  return settings.crubTech && settings.staircasing && settings.shadingMethod === "suppress_2layer";
}

// The 2-Layer variant for maps that need late shading.
export function pngToNbtLateShading(settings) {
  return usesCrubTech(settings) ? CRUBTECH.lateShading : settings.lateShading;
}

export function pngToNbtOptions(settings) {
  const mode = settings.staircasing ? settings.shadingMethod : "flat";
  const crubTech = usesCrubTech(settings);
  const support = crubTech ? crubTechSupportMode(settings.support) : settings.support;
  const options = { mode, minecraftVersion: settings.versionKey, support };
  // an empty field means PNG-to-NBT's default, which is what the field shows as its placeholder;
  // CrubTech uses its own breakable / pushable blocks instead of the support and noobline blocks
  if (!crubTech && support !== "none" && cleanBlockName(settings.supportBlock) !== "") {
    options.supportBlock = cleanBlockName(settings.supportBlock);
  }
  if (!crubTech && cleanBlockName(settings.shadeBlock) !== "") {
    options.shadeBlock = cleanBlockName(settings.shadeBlock);
  }
  if (isSuppressMethod(mode)) {
    options.direction = crubTech ? CRUBTECH.suppressDirection : settings.suppressDirection;
    options.centerOut = crubTech ? false : !settings.suppressOneDirection;
  }
  if (isStepsMethod(mode)) {
    options.reuseBlocks = settings.keepReusableBlocks;
    options.keepExtras = !settings.blockRecycling;
  }
  if (mode === "suppress_2layer") {
    if (crubTech) {
      options.crubTech = true;
      if (cleanBlockName(settings.crubTechPushableBlock) !== "") {
        options.crubTechPushableBlock = cleanBlockName(settings.crubTechPushableBlock);
      }
    } else {
      const spacing = twoLayerSpacing(support, settings.layerGap, settings.latePairsGap, false);
      options.layerGap = spacing.layerGap;
      options.latePairsGap = spacing.latePairsGap;
    }
  }
  return options;
}

function isInvalidInput(error) {
  return error !== null && typeof error === "object" && error.code === "INVALID_INPUT";
}

// One map through the generator. Two refusals depend on the map rather than on the settings, so they get
// another try instead of an error: a 2-Layer map that needs late shading is built with the chosen late
// variant, and a suppression direction that would lose a map's void or water shading moves on to the next
// direction (east-west always works). onAdjust(kind, value) hears about either.
export async function generateMapTile(connection, request, lateShading, onAdjust) {
  const { options } = request;
  if (options.mode === "suppress_2layer") {
    try {
      return await connection.generateTile(request);
    } catch (error) {
      if (!isInvalidInput(error) || !/late/i.test(error.message)) {
        throw error;
      }
      onAdjust("lateShading", lateShading);
      return connection.generateTile({ ...request, options: { ...options, mode: lateShading } });
    }
  }
  if (isStepsMethod(options.mode)) {
    const start = Math.max(0, DIRECTION_CYCLE.indexOf(options.direction));
    const directions = [options.direction, ...DIRECTION_CYCLE.slice(start + 1), ...DIRECTION_CYCLE.slice(0, start)];
    let firstError = null;
    for (const direction of directions) {
      try {
        const result = await connection.generateTile({ ...request, options: { ...options, direction } });
        if (direction !== options.direction) {
          onAdjust("direction", direction);
        }
        return result;
      } catch (error) {
        if (!isInvalidInput(error) || !/direction/i.test(error.message)) {
          throw error;
        }
        if (firstError === null) {
          firstError = error;
        }
      }
    }
    throw firstError;
  }
  return connection.generateTile(request);
}

let connectionPromise = null;
let failedConnections = 0;

// Connect once and reuse the connection; it queues calls in order. A connection that fails is forgotten,
// so the next download tries again; the retry gets a query string because some browsers remember a failed
// module import for the rest of the visit.
export function connectPngToNbt() {
  if (connectionPromise === null) {
    const url = failedConnections === 0 ? PNG_TO_NBT_API_URL : `${PNG_TO_NBT_API_URL}?retry=${failedConnections}`;
    connectionPromise = import(/* webpackIgnore: true */ url).then((api) => api.connect());
    connectionPromise.catch(() => {
      failedConnections += 1;
      connectionPromise = null;
    });
  }
  return connectionPromise;
}

const BROKEN_CONNECTION_CODES = ["DISPOSED", "WORKER_FAILED", "PROTOCOL_ERROR", "PROTOCOL_MISMATCH"];

// After a failure that leaves the connection unusable, drop it so the next download reconnects.
export function forgetBrokenPngToNbtConnection(error) {
  if (connectionPromise === null || error === null || typeof error !== "object" || !BROKEN_CONNECTION_CODES.includes(error.code)) {
    return;
  }
  const broken = connectionPromise;
  connectionPromise = null;
  broken.then(
    (connection) => connection.dispose(),
    () => {}
  );
}

const CONNECTION_FAILURE_CODES = ["CONNECTION_TIMEOUT", "CONNECTION_FAILED", "PROTOCOL_MISMATCH", "PROTOCOL_ERROR"];

// True for failures to load or reach the generator at all, as opposed to it refusing a map. A failed
// import() of api.js has no code.
export function isPngToNbtConnectionFailure(error) {
  if (error === null || typeof error !== "object" || error.code === undefined) {
    return true;
  }
  return CONNECTION_FAILURE_CODES.includes(error.code);
}

// "blocks[12] is not a catalog state ..." -> 12, the base colour id PNG-to-NBT refused a block for.
export function rejectedBlockColourId(error) {
  if (!isInvalidInput(error)) {
    return null;
  }
  const match = /^blocks\[(\d+)\]/.exec(error.message);
  return match === null ? null : parseInt(match[1]);
}

// ---------------------------------------------------------------- palette check
//
// Minecraft 26.3 renamed the block-state fields of structure palettes from {Name, Properties} to
// {id, properties}. MapartCraft never asks PNG-to-NBT for that format, but should a palette entry come back
// with the new names anyway, it is renamed and the file's DataVersion is put back to 26.2's, so Minecraft
// upgrades it on load and older tools such as Litematica can read it.

const FIRST_LOWERCASE_STATE_DATA_VERSION = 5006;
const LAST_NAME_STATE_DATA_VERSION = 4903;

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

// Compounds become [{type, name, value}], lists {elementType, items}; long and array payloads stay raw bytes.
function parseNbt(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const readString = () => {
    const length = view.getUint16(offset);
    offset += 2;
    const text = textDecoder.decode(bytes.subarray(offset, offset + length));
    offset += length;
    return text;
  };
  const readRaw = (length) => {
    const raw = bytes.slice(offset, offset + length);
    offset += length;
    return raw;
  };
  const readPayload = (type) => {
    switch (type) {
      case 1: {
        offset += 1;
        return view.getInt8(offset - 1);
      }
      case 2: {
        offset += 2;
        return view.getInt16(offset - 2);
      }
      case 3: {
        offset += 4;
        return view.getInt32(offset - 4);
      }
      case 4: {
        return readRaw(8);
      }
      case 5: {
        offset += 4;
        return view.getFloat32(offset - 4);
      }
      case 6: {
        offset += 8;
        return view.getFloat64(offset - 8);
      }
      case 7: {
        offset += 4;
        return readRaw(view.getInt32(offset - 4));
      }
      case 8: {
        return readString();
      }
      case 9: {
        const elementType = view.getUint8(offset);
        const count = view.getInt32(offset + 1);
        offset += 5;
        const items = [];
        for (let i = 0; i < count; i++) {
          items.push(readPayload(elementType));
        }
        return { elementType, items };
      }
      case 10: {
        const tags = [];
        for (;;) {
          const tagType = view.getUint8(offset);
          offset += 1;
          if (tagType === 0) {
            return tags;
          }
          const name = readString();
          tags.push({ type: tagType, name, value: readPayload(tagType) });
        }
      }
      case 11:
      case 12: {
        const length = view.getInt32(offset);
        offset += 4;
        return { length, raw: readRaw(length * (type === 11 ? 4 : 8)) };
      }
      default: {
        throw new Error(`Unknown NBT tag type ${type}`);
      }
    }
  };
  const type = view.getUint8(offset);
  offset += 1;
  const name = readString();
  return { type, name, value: readPayload(type) };
}

function serialiseNbt(root) {
  let bytes = new Uint8Array(1 << 16);
  let view = new DataView(bytes.buffer);
  let length = 0;
  const reserve = (size) => {
    if (length + size <= bytes.length) {
      return;
    }
    let capacity = bytes.length * 2;
    while (capacity < length + size) {
      capacity *= 2;
    }
    const grown = new Uint8Array(capacity);
    grown.set(bytes.subarray(0, length));
    bytes = grown;
    view = new DataView(bytes.buffer);
  };
  const writeNumber = (setter, size, value) => {
    reserve(size);
    view[setter](length, value);
    length += size;
  };
  const writeRaw = (raw) => {
    reserve(raw.length);
    bytes.set(raw, length);
    length += raw.length;
  };
  const writeString = (text) => {
    const encoded = textEncoder.encode(text);
    writeNumber("setUint16", 2, encoded.length);
    writeRaw(encoded);
  };
  const writePayload = (type, value) => {
    switch (type) {
      case 1: {
        writeNumber("setInt8", 1, value);
        break;
      }
      case 2: {
        writeNumber("setInt16", 2, value);
        break;
      }
      case 3: {
        writeNumber("setInt32", 4, value);
        break;
      }
      case 4: {
        writeRaw(value);
        break;
      }
      case 5: {
        writeNumber("setFloat32", 4, value);
        break;
      }
      case 6: {
        writeNumber("setFloat64", 8, value);
        break;
      }
      case 7: {
        writeNumber("setInt32", 4, value.length);
        writeRaw(value);
        break;
      }
      case 8: {
        writeString(value);
        break;
      }
      case 9: {
        writeNumber("setUint8", 1, value.elementType);
        writeNumber("setInt32", 4, value.items.length);
        for (const item of value.items) {
          writePayload(value.elementType, item);
        }
        break;
      }
      case 10: {
        for (const tag of value) {
          writeNumber("setUint8", 1, tag.type);
          writeString(tag.name);
          writePayload(tag.type, tag.value);
        }
        writeNumber("setUint8", 1, 0);
        break;
      }
      case 11:
      case 12: {
        writeNumber("setInt32", 4, value.length);
        writeRaw(value.raw);
        break;
      }
      default: {
        throw new Error(`Unknown NBT tag type ${type}`);
      }
    }
  };
  writeNumber("setUint8", 1, root.type);
  writeString(root.name);
  writePayload(root.type, root.value);
  return bytes.slice(0, length);
}

function renamePaletteFields(paletteList) {
  let renamed = false;
  if (paletteList.elementType !== 10) {
    return renamed;
  }
  for (const entry of paletteList.items) {
    const hasName = entry.some((tag) => tag.name === "Name");
    const hasProperties = entry.some((tag) => tag.name === "Properties");
    for (const tag of entry) {
      if (tag.name === "id" && tag.type === 8 && !hasName) {
        tag.name = "Name";
        renamed = true;
      } else if (tag.name === "properties" && tag.type === 10 && !hasProperties) {
        tag.name = "Properties";
        renamed = true;
      }
    }
  }
  return renamed;
}

// Returns the gzipped structure with every palette entry keyed Name/Properties; untouched when it already is.
export function withNamedPaletteEntries(gzippedStructure) {
  const root = parseNbt(ungzip(gzippedStructure));
  if (root.type !== 10) {
    return gzippedStructure;
  }
  let renamed = false;
  for (const tag of root.value) {
    if (tag.type === 9 && tag.name === "palette") {
      renamed = renamePaletteFields(tag.value) || renamed;
    } else if (tag.type === 9 && tag.name === "palettes" && tag.value.elementType === 9) {
      for (const paletteList of tag.value.items) {
        renamed = renamePaletteFields(paletteList) || renamed;
      }
    }
  }
  if (!renamed) {
    return gzippedStructure;
  }
  const dataVersion = root.value.find((tag) => tag.type === 3 && tag.name === "DataVersion");
  if (dataVersion !== undefined && dataVersion.value >= FIRST_LOWERCASE_STATE_DATA_VERSION) {
    dataVersion.value = LAST_NAME_STATE_DATA_VERSION;
  }
  return gzip(serialiseNbt(root));
}
