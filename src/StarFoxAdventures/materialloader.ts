import { colorFromRGBA, colorNewCopy, White } from '../Color.js';
import { Shader, ShaderLayer, ShaderFlags, ShaderAttrFlags } from './materials.js';
import { dataSubarray } from './util.js';

const ATTR_CLR  = (ShaderAttrFlags as any).CLR  ?? 0x01;
const ATTR_TEX0 = (ShaderAttrFlags as any).TEX0 ?? 0x04;
const ATTR_TEX1 = (ShaderAttrFlags as any).TEX1 ?? 0x08;

interface ShaderFields {
    isAncient?: boolean;
    isBeta?: boolean;
    isold?: boolean;
    isEarly1?: boolean; 
    isEarly3?: boolean; 
    isSwapcircle?: boolean;
    size: number;
    numLayers: number;
    layers: number;
}

export const KNOWN_WATER_TEXIDS = new Set<number>([
  // Existing Early1 IDs…
  899, 2871,

]);

export const KNOWN_WATER_TEXIDS3 = new Set<number>([
  // Existing Early1 IDs…
  

]);


export const KNOWN_ANCIENT_WATER_TEXIDS = new Set<number>([

   2373, 2794, 24, 2871, 713, 611, 2793
]);

export const KNOWN_CUTOUT_TEXIDS_BETA = new Set<number>([
3254, 3272, 189, // TODO: put your IDs here, e.g. 142, 511, 733
]);

export const KNOWN_CUTOUT_TEXIDS_ANCIENT = new Set<number>([
  630, 646, 672,  1094, 1098, 1103, 1107, 1110, 1111, 1112// leaf/flower/grass texIds (resolved IDs)
  // TODO: put your IDs here, e.g. 142, 511, 733
]);
export const KNOWN_CUTOUT_TEXIDS_EARLY1 = new Set<number>([
1692, 1135, 1695, 1131 , 176, 783, 785 

]);

export const KNOWN_CUTOUT_TEXIDS_EARLY3 = new Set<number>([
678, 675
]);
export const KNOWN_LAVA_TEXIDS = new Set<number>([584, 585, 1061, 1062, 32728, 682]); 


export const SFA_SHADER_FIELDS: ShaderFields = {
    
    size: 0x44,
    numLayers: 0x41,
    layers: 0x24,
};

export const SFADEMO_MODEL_SHADER_FIELDS: ShaderFields = {
   isBeta: true,
    isEarly1: true,
    size: 0x40,
    numLayers: 0x3b,
    layers: 0x24, // ???
};

export const SFADEMO_MAP_SHADER_FIELDS: ShaderFields = {
    isBeta: true,
    isEarly1: true,
    size: 0x40,
    numLayers: 0x3b,
    layers: 0x24, // ???
};

export const VERY_EARLY_2001: ShaderFields = {
    isBeta: true,
    isold: true,
    size: 0x40,
    numLayers: 0x3b,
    layers: 0x24, // ???
};

export const BETA_MAP_SHADER_FIELDS: ShaderFields = {
    isBeta: true,
    isSwapcircle: true,
    size: 0x38,
    numLayers: 0x36,
    layers: 0x20,
};

export const BETA_MODEL_SHADER_FIELDS: ShaderFields = {
    isBeta: true,
    size: 0x38,
    numLayers: 0x36,
    layers: 0x20,
};

export const ANCIENT_MAP_SHADER_FIELDS: ShaderFields = {
    isAncient: true,
    size: 0x3c,
    numLayers: 0x3a,
    layers: 0x24,
};
export const EARLY2_MAP_SHADER_FIELDS: ShaderFields = {
    isBeta: true,
    isEarly3: true, 
    size: 0x44,
    numLayers: 0x3f,
    layers: 0x24,
};

export const EARLY3_MAP_SHADER_FIELDS: ShaderFields = {
    isBeta: true,
    isEarly3: true,  
    size: 0x44,
    numLayers: 0x3f,
    layers: 0x24,
};


function parseModelTexId(data: DataView, offs: number, modelTexIds: number[]): number | null {
    const idx = data.getUint32(offs);
    return idx !== 0xffffffff ? modelTexIds[idx] : null;
}

function parseShaderLayer(data: DataView, modelTexIds: number[]): ShaderLayer {
    const scrollingTexMtx = data.getUint8(0x6);
    return {
        texId: parseModelTexId(data, 0x0, modelTexIds),
        tevMode: data.getUint8(0x4),
        enableScroll: data.getUint8(0x5),
        scrollSlot: scrollingTexMtx || undefined,
    };
}

const enum Early1Bits {
//  Fog              = 0x800000000,
  CullBackface     = 0x0008,
  ReflectSkyscape  = 0x0020,
  //Caustic          = 0x4000,
 // Lava             = 0x0080000000000,
//  Reflective       = 0x0100,
    AlphaCompareLo   = 0x0040,  // grates/leaves/etc.
  AlphaCompareHi   = 0x0100,  // most foliage
  ShortFur         = 0x4000,
  MediumFur        = 0x8000,
}

function translateEarly1Flags(raw16: number): number {
  let out = 0;
//  if (raw16 & Early1Bits.Fog)              out |= ShaderFlags.Fog;
  if (raw16 & Early1Bits.CullBackface)     out |= ShaderFlags.CullBackface;
  if (raw16 & Early1Bits.ReflectSkyscape)  out |= ShaderFlags.ReflectSkyscape;
//  if (raw16 & Early1Bits.Caustic)          out |= ShaderFlags.Caustic;
//  if (raw16 & Early1Bits.Lava)             out |= ShaderFlags.Lava;
//  if (raw16 & Early1Bits.Reflective)       out |= ShaderFlags.Reflective;
  if (raw16 & Early1Bits.AlphaCompareLo)  out |= ShaderFlags.AlphaCompare;
  if (raw16 & Early1Bits.AlphaCompareHi)  out |= ShaderFlags.AlphaCompare; 
   if (raw16 & Early1Bits.ShortFur)         out |= ShaderFlags.ShortFur;
  if (raw16 & Early1Bits.MediumFur)        out |= ShaderFlags.MediumFur;
  
  return out;
}


const enum Early3Bits {
  DevGeometry      = 0x0002,
  Fog              = 0x0004,
  CullBackface     = 0x0008, //0x0010
  ReflectSkyscape  = 0x0020,
  Caustic          = 0x0040,
//  Lava             = 0x0100,
  Reflective       = 0x0100,
  AlphaCompareLo     = 0x0400,   // cutout 4000
 AlphaCompareHi    = 0x4000,   // cutout 4000

 
}

function translateEarly3Flags(raw16: number): number {
  let out = 0;
  if (raw16 & Early3Bits.DevGeometry)      out |= ShaderFlags.DevGeometry;
  if (raw16 & Early3Bits.Fog)              out |= ShaderFlags.Fog;
  if (raw16 & Early3Bits.CullBackface)     out |= ShaderFlags.CullBackface;
  if (raw16 & Early3Bits.ReflectSkyscape)  out |= ShaderFlags.ReflectSkyscape;
  if (raw16 & Early3Bits.Caustic)          out |= ShaderFlags.Caustic;
//  if (raw16 & Early3Bits.Lava)             out |= ShaderFlags.Lava;
 if (raw16 & Early3Bits.Reflective)       out |= ShaderFlags.Reflective;
  if (raw16 & Early3Bits.AlphaCompareLo)     out |= ShaderFlags.AlphaCompare; // cutout
  if (raw16 & Early3Bits.AlphaCompareHi)     out |= ShaderFlags.AlphaCompare; // cutout

  return out;
}

export function parseShader(
  data: DataView,
  fields: ShaderFields,
  modelTexIds: number[],
  normalFlags: number,
  lightFlags: number,
  texMtxCount: number,
): Shader {
  const shader: Shader = {
    layers: [],
    flags: 0,
    attrFlags: 0,
    hasHemisphericProbe: false,
    hasReflectiveProbe: false,
    reflectiveProbeMaskTexId: null,
    reflectiveProbeIdx: 0,
    reflectiveAmbFactor: 0.0,
    hasNBTTexture: false,
    nbtTexId: null,
    nbtParams: 0,
    furRegionsTexId: null,
    color: colorNewCopy(White),
    normalFlags,
    lightFlags,
    texMtxCount,
  };

  let numLayers = data.getUint8(fields.numLayers);
  if (numLayers > 2) {
    console.warn(`Number of shader layers greater than maximum (${numLayers} / 2)`);
    numLayers = 2;
  }

  for (let i = 0; i < numLayers; i++) {
    const layer = parseShaderLayer(dataSubarray(data, fields.layers + i * 8), modelTexIds);
    shader.layers.push(layer);
  }

if (fields.isAncient) {
  shader.isAncient = true;
  const flags8 = data.getUint8(0x38);
  let   attr   = data.getUint8(0x39);
  shader.flags     = ShaderFlags.CullBackface;
  shader.attrFlags = attr;

  if (shader.layers[0]?.texId != null) shader.attrFlags |= ATTR_TEX0;
  if (shader.layers[1]?.texId != null) shader.attrFlags |= ATTR_TEX1;
  if (shader.attrFlags === 0)          shader.attrFlags |= ATTR_CLR;

  const first  = shader.layers[0];
  const lowNib = flags8 & 0x0F;

  const looksWater =
    ((lowNib === 0x0D || lowNib === 0x0C) && (first?.texId != null)) ||
    (first?.texId === 1392 || first?.texId === 24 || first?.texId === 1234 || first?.texId === 5678|| first?.texId === 1391
    ) ||
    (first?.texId != null && KNOWN_ANCIENT_WATER_TEXIDS.has(first.texId));

  if (looksWater) shader.flags |= ShaderFlags.Water;
  const singleLayer = shader.layers.length === 1;
  const hasTex      = first?.texId != null;
  const tevPlain    = first && (first.tevMode === 0x00 || first.tevMode === 0x01 || first.tevMode === 0x02);

  const isCutoutTex =
    (first?.texId ===  928  || first?.texId === 791 || first?.texId === 430|| first?.texId === 573|| first?.texId === 575||
         first?.texId === 576|| first?.texId === 577 || first?.texId === 2882|| first?.texId === 44) || first?.texId === 2046||
    first?.texId === 2228||first?.texId === 2467||first?.texId === 2538|| first?.texId === 1798  || first?.texId === 2791
   ||first?.texId === 574|| first?.texId === 684||  first?.texId === 96|| first?.texId === 740||first?.texId === 0|| 
   first?.texId === 595||first?.texId === 596|| first?.texId === 593||first?.texId === 594||first?.texId === 592||
   first?.texId === 589||      (first?.texId != null && KNOWN_CUTOUT_TEXIDS_ANCIENT.has(first.texId));

   if (singleLayer && hasTex && !looksWater && tevPlain && isCutoutTex) {
    shader.flags |= ShaderFlags.AlphaCompare;
  }


  return shader;

} else if (fields.isSwapcircle) {

  const flags8 = data.getUint8(0x34);
  const attr   = data.getUint8(0x35);

  shader.isBeta     = true;
  shader.flags      = ShaderFlags.CullBackface;
  shader.attrFlags  = attr;

  // Derive attr bits from layer usage if missing
  if (shader.layers[0]?.texId != null) shader.attrFlags |= ATTR_TEX0;
  if (shader.layers[1]?.texId != null) shader.attrFlags |= ATTR_TEX1;
  if ((shader.attrFlags & (ATTR_CLR | ATTR_TEX0 | ATTR_TEX1)) === 0)
    shader.attrFlags |= ATTR_CLR;

  const L0      = shader.layers[0];
  const L1      = shader.layers[1];
  const texId0  = L0?.texId ?? null;
  const texId1  = L1?.texId ?? null;
  const tmode0  = (L0?.tevMode ?? 0) & 0x7f;
  const tmode1  = (L1?.tevMode ?? 0) & 0x7f;
  const lowNib  = flags8 & 0x0F;

  const singleLayer =
    shader.layers.length === 1 ||
    (shader.layers.length >= 2 && shader.layers[1]?.texId == null);
  const hasTex0   = texId0 != null;
  const tevPlain0 = (tmode0 === 0x00 || tmode0 === 0x01 || tmode0 === 0x02 || tmode0 === 0x03);
  const tevOkAny  = (tmode0 === 0x02 || tmode0 === 0x03) || (tmode1 === 0x02 || tmode1 === 0x03);

  // Cutout detection (use layer 0’s texture for alpha-cut foliage)
  const isCutout0 =
      (texId0 != null && (
          KNOWN_CUTOUT_TEXIDS_BETA.has(texId0) ||
          KNOWN_CUTOUT_TEXIDS_ANCIENT.has(texId0) ||
          (typeof KNOWN_CUTOUT_TEXIDS_EARLY1 !== 'undefined' && KNOWN_CUTOUT_TEXIDS_EARLY1.has(texId0))
      ));

  if (singleLayer && hasTex0 && tevPlain0 && isCutout0)
    shader.flags |= ShaderFlags.AlphaCompare;

  const anyKnownWater =
      (texId0 != null && KNOWN_WATER_TEXIDS.has(texId0)) ||
      (texId1 != null && KNOWN_WATER_TEXIDS.has(texId1));

  if (anyKnownWater) {
    shader.flags |= ShaderFlags.Water;
  } else {
    if (hasTex0 && (tevOkAny || lowNib === 0x0D || lowNib === 0x0C))
      shader.flags |= ShaderFlags.Water;
  }

  const isLava =
      [texId0, texId1].some(id =>
        id === 32928 || id === 584 || id === 1061 || id === 1062 || id === 585
      );
  if (isLava) {
    shader.flags |= ShaderFlags.Lava;
    shader.flags &= ~ShaderFlags.Water; // never both
  }

  shader.hasHemisphericProbe = data.getUint32(0x08) === 1;
  shader.hasReflectiveProbe  = data.getUint32(0x14) === 1;
  shader.hasNBTTexture       = !!(data.getUint8(0x37) & 0x80);

  return shader;

    
  } else if (fields.isBeta) {
  shader.isBeta = true;
       shader.attrFlags = ShaderAttrFlags.CLR;
        shader.flags = ShaderFlags.CullBackface;
 
if (fields.isold) {
  const raw16 = data.getUint16(0x38);
  const attr  = data.getUint8(0x3A);
  shader.attrFlags = attr;

  // Base flags
  let flags = 0;
  if (raw16 & ShaderFlags.CullBackface) flags |= ShaderFlags.CullBackface;
  if (raw16 & 0x0800)                   flags |= 0x0800; // lighting combine quirk
  if (raw16 & 0x1000)                   flags |= 0x1000; // lighting combine quirk
  shader.flags = flags;

  const L0     = shader.layers[0];
  const texId  = L0?.texId ?? null;
  const tmode  = (L0?.tevMode ?? 0) & 0x7f;
  const tevOk  = (tmode === 0x02 || tmode === 0x03);
  const lowNib = raw16 & 0x0F;

  const singleLayer = shader.layers.length === 1 ||
    (shader.layers.length >= 2 && shader.layers[1]?.texId == null);
  const hasTex   = texId != null;
  const tevPlain = (tmode === 0x00 || tmode === 0x01 || tmode === 0x02);

  const isCutoutTex =
    (texId === 177  || texId === 526  || texId === 525  || texId === 982  || texId === 536  ||
     texId === 1294 || texId === 1295 || texId === 418  || texId === 88   || texId === 571  ||
     texId === 44   || texId === 668  || texId === 417  || texId === 2090 || texId === 568  ||
     texId === 567  || texId === 638  || texId === 810  || texId === 2094 || texId === 691  ||
     texId === 944  || texId === 7    || texId === 769  || texId === 767  || texId === 1156 ||
     texId === 996  || texId === 811  || texId === 2056 || texId === 189  || texId === 176) ||
    (texId != null && KNOWN_CUTOUT_TEXIDS_ANCIENT.has(texId)) ||
    (typeof KNOWN_CUTOUT_TEXIDS_EARLY1 !== 'undefined' && texId != null && KNOWN_CUTOUT_TEXIDS_EARLY1.has(texId));

  if (singleLayer && hasTex && tevPlain && isCutoutTex)
    shader.flags |= ShaderFlags.AlphaCompare;

  if (hasTex && !isCutoutTex) {
    const isKnownWater = KNOWN_WATER_TEXIDS.has(texId!);
    const strongById   = (texId === 899) || isKnownWater;
    const heurWater    = isKnownWater && tevOk && (lowNib === 0x0D || lowNib === 0x0C);
    if (strongById || heurWater)
      shader.flags |= ShaderFlags.Water;

    const isLavaTexId = texId === 457 || texId === 584 || texId === 1061 || texId === 1062 || texId === 585;
    if (isLavaTexId) {
      shader.flags |= ShaderFlags.Lava;
      shader.flags &= ~ShaderFlags.Water; // never both
    }
  }

  return shader;
}

if (fields.isEarly1) {
  const raw16 = data.getUint16(0x38);
  shader.isBeta    = true;
  shader.flags     = translateEarly1Flags(raw16);
  shader.flags    &= ~ShaderFlags.DevGeometry;  // <-- ignore "dev" for Early-1
  shader.attrFlags = data.getUint8(0x3A);

  if (shader.layers[0]?.texId != null) shader.attrFlags |= ATTR_TEX0;
  if (shader.layers[1]?.texId != null) shader.attrFlags |= ATTR_TEX1;
  if ((shader.attrFlags & (ATTR_CLR | ATTR_TEX0 | ATTR_TEX1)) === 0)
    shader.attrFlags |= ATTR_CLR;

  const tm0 = (shader.layers[0]?.tevMode ?? 0) & 0x7F;
  const tm1 = (shader.layers[1]?.tevMode ?? 0) & 0x7F;
  const lowNib = raw16 & 0x0F;
  const tevOk = (tm0 === 0x02 || tm0 === 0x03) || (tm1 === 0x02 || tm1 === 0x03);
  if ((lowNib === 0x0C || lowNib === 0x0D) && tevOk)
    shader.flags |= ShaderFlags.Water;

  colorFromRGBA(shader.color,
    data.getUint8(0x04) / 0xFF,
    data.getUint8(0x05) / 0xFF,
    data.getUint8(0x06) / 0xFF,
    1.0
  );
  return shader;
}




if ((fields as any).isEarly3) {
  const raw16 = data.getUint16(0x3c);
  shader.isBeta    = true;
  shader.flags     = translateEarly3Flags(raw16);
  shader.attrFlags = data.getUint8(0x3e);

  if (shader.layers[0]?.texId != null) shader.attrFlags |= ATTR_TEX0;
  if (shader.layers[1]?.texId != null) shader.attrFlags |= ATTR_TEX1;
  if ((shader.attrFlags & (ATTR_CLR | ATTR_TEX0 | ATTR_TEX1)) === 0)
    shader.attrFlags |= ATTR_CLR;

  shader.hasHemisphericProbe = data.getUint32(0x08) !== 0;
  shader.hasReflectiveProbe  = data.getUint32(0x14) !== 0;
  shader.reflectiveProbeMaskTexId = parseModelTexId(data, 0x18, modelTexIds);
  shader.reflectiveProbeIdx  = data.getUint8(0x20);
  shader.reflectiveAmbFactor = data.getUint8(0x22) / 0xff;
  shader.nbtTexId            = parseModelTexId(data, 0x34, modelTexIds);
  shader.hasNBTTexture       = shader.nbtTexId !== null;
  shader.nbtParams           = data.getUint8(0x42);
  shader.furRegionsTexId     = parseModelTexId(data, 0x38, modelTexIds);
  colorFromRGBA(shader.color,
    data.getUint8(0x04) / 0xff,
    data.getUint8(0x05) / 0xff,
    data.getUint8(0x06) / 0xff,
    1.0);


  return shader;

}




  } else {
    shader.flags = data.getUint32(0x3c);
    shader.attrFlags = data.getUint8(0x40);
    shader.hasHemisphericProbe = data.getUint32(0x8) !== 0;
    shader.hasReflectiveProbe = data.getUint32(0x14) !== 0;
    shader.reflectiveProbeMaskTexId = parseModelTexId(data, 0x18, modelTexIds);
    shader.reflectiveProbeIdx = data.getUint8(0x20);
    shader.reflectiveAmbFactor = data.getUint8(0x22) / 0xff;
    shader.nbtTexId = parseModelTexId(data, 0x34, modelTexIds);
    shader.hasNBTTexture = shader.nbtTexId !== null;
    shader.nbtParams = data.getUint8(0x42);
    shader.furRegionsTexId = parseModelTexId(data, 0x38, modelTexIds);
    colorFromRGBA(shader.color,
      data.getUint8(0x4) / 0xff,
      data.getUint8(0x5) / 0xff,
      data.getUint8(0x6) / 0xff,
      1.0);
  }

  return shader;
}
// --- end replace ---
