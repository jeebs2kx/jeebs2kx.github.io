import { vec3 } from 'gl-matrix';
import ArrayBufferSlice from '../ArrayBufferSlice.js';
import { AABB } from '../Geometry.js';
import { GX_Array, GX_VtxAttrFmt, GX_VtxDesc } from '../gx/gx_displaylist.js';
import * as GX from '../gx/gx_enum.js';
import { nArray } from '../util.js';
import {
  parseShader,
  ANCIENT_MAP_SHADER_FIELDS,
  SFA_SHADER_FIELDS,
  BETA_MODEL_SHADER_FIELDS,
  BETA_MAP_SHADER_FIELDS,
  SFADEMO_MAP_SHADER_FIELDS,
  SFADEMO_MODEL_SHADER_FIELDS,
  EARLY2_MAP_SHADER_FIELDS,
  EARLY3_MAP_SHADER_FIELDS,
  VERY_EARLY_2001,
} from './materialloader.js';
import {
  MaterialFactory,
  NormalFlags,
  SFAMaterial,
  Shader,
  ShaderAttrFlags,
  ShaderFlags,
} from './materials.js';
import { Model, ModelShapes } from './models.js';
import { Shape, ShapeGeometry, ShapeMaterial } from './shapes.js';
import { Skeleton } from './skeleton.js';
import { TextureFetcher } from './textures.js';
import {
  dataCopy,
  dataSubarray,
  LowBitReader,
  readUint16,
  readUint32,
  readVec3,
} from './util.js';

export enum ModelVersion {
  AncientMap,
  Beta,
  BetaMap,
  Demo,
  cloudtreasure,
  DemoMap,
  Final,
  FinalMap,
  fear,
  dfpt,
  dup,
  Early1,
  Early2,
  Early3,
  Early4,
}

interface DisplayListInfo {
  offset: number;
  size: number;
  aabb?: AABB;
  specialBitAddress?: number; // Command bit address for fur/grass or water
  sortLayer?: number; // Used in map blocks only
}

function parseDisplayListInfo(data: DataView): DisplayListInfo {
  return {
    offset: data.getUint32(0x0),
    size: data.getUint16(0x4),
    aabb: new AABB(
      data.getInt16(0x6) / 8,
      data.getInt16(0x8) / 8,
      data.getInt16(0xa) / 8,
      data.getInt16(0xc) / 8,
      data.getInt16(0xe) / 8,
      data.getInt16(0x10) / 8,
    ),
    specialBitAddress: data.getUint16(0x14), // Points to fur and water shapes
    sortLayer: data.getUint8(0x18), // Used in map blocks only
  }
}

interface FineSkinningConfig {
  numPieces: number;
  quantizeScale: number;
}

const FineSkinningPiece_SIZE = 0x74;

interface FineSkinningPiece {
  skinDataSrcOffs: number;
  weightsSrc: number;
  bone0: number;
  bone1: number;
  weightsBlockCount: number;
  numVertices: number;
  skinMeOffset: number;
  skinSrcBlockCount: number; // A block is 32 bytes
}

function parseFineSkinningConfig(data: DataView): FineSkinningConfig {
  return {
    numPieces: data.getUint16(0x2),
    quantizeScale: data.getUint8(0x6),
  };
}

function parseFineSkinningPiece(data: DataView): FineSkinningPiece {
  return {
    skinDataSrcOffs: data.getUint32(0x60),
    weightsSrc: data.getUint32(0x64),
    bone0: data.getUint8(0x6c),
    bone1: data.getUint8(0x6d),
    weightsBlockCount: data.getUint8(0x6f),
    numVertices: data.getUint16(0x70),
    skinMeOffset: data.getUint8(0x72),
    skinSrcBlockCount: data.getUint8(0x73),
  };
}

type BuildMaterialFunc = (
  shader: Shader,
  texFetcher: TextureFetcher,
  texIds: number[],
  isMapBlock: boolean,
) => SFAMaterial;

// Generate vertex attribute tables.
// The game initializes the VATs upon startup and uses them unchanged for nearly
// everything.
// The final version of the game has a minor difference in VAT 5 compared to beta
// and older versions.
function generateVat(old: boolean, nbt: boolean): GX_VtxAttrFmt[][] {
  const vat: GX_VtxAttrFmt[][] = nArray(8, () => []);
  for (let i = 0; i <= GX.Attr.MAX; i++) {
    for (let j = 0; j < 8; j++)
      vat[j][i] = { compType: GX.CompType.U8, compShift: 0, compCnt: 0 };
  }

  vat[0][GX.Attr.POS] = { compType: GX.CompType.S16, compShift: 0, compCnt: GX.CompCnt.POS_XYZ };
  vat[0][GX.Attr.CLR0] = { compType: GX.CompType.RGBA8, compShift: 0, compCnt: GX.CompCnt.CLR_RGBA };
  vat[0][GX.Attr.TEX0] = { compType: GX.CompType.S16, compShift: 7, compCnt: GX.CompCnt.TEX_ST };

  vat[1][GX.Attr.POS] = { compType: GX.CompType.S16, compShift: 2, compCnt: GX.CompCnt.POS_XYZ };
  vat[1][GX.Attr.CLR0] = { compType: GX.CompType.RGBA8, compShift: 0, compCnt: GX.CompCnt.CLR_RGBA };
  vat[1][GX.Attr.TEX0] = { compType: GX.CompType.F32, compShift: 0, compCnt: GX.CompCnt.TEX_ST };

  vat[2][GX.Attr.POS] = { compType: GX.CompType.F32, compShift: 0, compCnt: GX.CompCnt.POS_XYZ };
  vat[2][GX.Attr.NRM] = { compType: GX.CompType.F32, compShift: 0, compCnt: GX.CompCnt.NRM_XYZ };
  vat[2][GX.Attr.CLR0] = { compType: GX.CompType.RGBA8, compShift: 0, compCnt: GX.CompCnt.CLR_RGBA };
  vat[2][GX.Attr.TEX0] = { compType: GX.CompType.F32, compShift: 0, compCnt: GX.CompCnt.TEX_ST };
  vat[2][GX.Attr.TEX1] = { compType: GX.CompType.F32, compShift: 0, compCnt: GX.CompCnt.TEX_ST };

  vat[3][GX.Attr.POS] = { compType: GX.CompType.S16, compShift: 8, compCnt: GX.CompCnt.POS_XYZ };
  vat[3][GX.Attr.NRM] = { compType: GX.CompType.S8, compShift: 0, compCnt: nbt ? GX.CompCnt.NRM_NBT : GX.CompCnt.NRM_XYZ };
  vat[3][GX.Attr.CLR0] = { compType: GX.CompType.RGBA4, compShift: 0, compCnt: GX.CompCnt.CLR_RGBA };
  vat[3][GX.Attr.TEX0] = { compType: GX.CompType.S16, compShift: 10, compCnt: GX.CompCnt.TEX_ST };
  vat[3][GX.Attr.TEX1] = { compType: GX.CompType.S16, compShift: 10, compCnt: GX.CompCnt.TEX_ST };
  vat[3][GX.Attr.TEX2] = { compType: GX.CompType.S16, compShift: 10, compCnt: GX.CompCnt.TEX_ST };
  vat[3][GX.Attr.TEX3] = { compType: GX.CompType.S16, compShift: 10, compCnt: GX.CompCnt.TEX_ST };

  vat[4][GX.Attr.POS] = { compType: GX.CompType.F32, compShift: 0, compCnt: GX.CompCnt.POS_XYZ };
  vat[4][GX.Attr.NRM] = { compType: GX.CompType.F32, compShift: 0, compCnt: GX.CompCnt.NRM_XYZ };
  vat[4][GX.Attr.CLR0] = { compType: GX.CompType.RGBA8, compShift: 0, compCnt: GX.CompCnt.CLR_RGBA };
  vat[4][GX.Attr.TEX0] = { compType: GX.CompType.S16, compShift: 7, compCnt: GX.CompCnt.TEX_ST };

  // The final version uses a 1/8 quantization factor; older versions do not use quantization.
  vat[5][GX.Attr.POS] = { compType: GX.CompType.S16, compShift: old ? 0 : 3, compCnt: GX.CompCnt.POS_XYZ };
  vat[5][GX.Attr.NRM] = { compType: GX.CompType.S8, compShift: 0, compCnt: nbt ? GX.CompCnt.NRM_NBT : GX.CompCnt.NRM_XYZ };
  vat[5][GX.Attr.CLR0] = { compType: GX.CompType.RGBA4, compShift: 0, compCnt: GX.CompCnt.CLR_RGBA };
  vat[5][GX.Attr.TEX0] = { compType: GX.CompType.S16, compShift: 8, compCnt: GX.CompCnt.TEX_ST };
  vat[5][GX.Attr.TEX1] = { compType: GX.CompType.S16, compShift: 8, compCnt: GX.CompCnt.TEX_ST };
  vat[5][GX.Attr.TEX2] = { compType: GX.CompType.S16, compShift: 8, compCnt: GX.CompCnt.TEX_ST };
  vat[5][GX.Attr.TEX3] = { compType: GX.CompType.S16, compShift: 8, compCnt: GX.CompCnt.TEX_ST };

  vat[6][GX.Attr.POS] = { compType: GX.CompType.S16, compShift: 8, compCnt: GX.CompCnt.POS_XYZ };
  vat[6][GX.Attr.NRM] = { compType: GX.CompType.S8, compShift: 0, compCnt: nbt ? GX.CompCnt.NRM_NBT : GX.CompCnt.NRM_XYZ };
  vat[6][GX.Attr.CLR0] = { compType: GX.CompType.RGBA4, compShift: 0, compCnt: GX.CompCnt.CLR_RGBA };
  vat[6][GX.Attr.TEX0] = { compType: GX.CompType.S16, compShift: 10, compCnt: GX.CompCnt.TEX_ST };
  vat[6][GX.Attr.TEX1] = { compType: GX.CompType.S16, compShift: 10, compCnt: GX.CompCnt.TEX_ST };
  vat[6][GX.Attr.TEX2] = { compType: GX.CompType.S16, compShift: 10, compCnt: GX.CompCnt.TEX_ST };
  vat[6][GX.Attr.TEX3] = { compType: GX.CompType.S16, compShift: 10, compCnt: GX.CompCnt.TEX_ST };

  vat[7][GX.Attr.POS] = { compType: GX.CompType.S16, compShift: 0, compCnt: GX.CompCnt.POS_XYZ };
  vat[7][GX.Attr.NRM] = { compType: GX.CompType.S8, compShift: 0, compCnt: nbt ? GX.CompCnt.NRM_NBT : GX.CompCnt.NRM_XYZ };
  vat[7][GX.Attr.CLR0] = { compType: GX.CompType.RGBA4, compShift: 0, compCnt: GX.CompCnt.CLR_RGBA };
  vat[7][GX.Attr.TEX0] = { compType: GX.CompType.S16, compShift: 10, compCnt: GX.CompCnt.TEX_ST };
  vat[7][GX.Attr.TEX1] = { compType: GX.CompType.S16, compShift: 10, compCnt: GX.CompCnt.TEX_ST };
  vat[7][GX.Attr.TEX2] = { compType: GX.CompType.S16, compShift: 10, compCnt: GX.CompCnt.TEX_ST };
  vat[7][GX.Attr.TEX3] = { compType: GX.CompType.S16, compShift: 10, compCnt: GX.CompCnt.TEX_ST };

  return vat;
}

const VAT = generateVat(false, false);
const VAT_NBT = generateVat(false, true);
const OLD_VAT = generateVat(true, false);
const OLD_VAT_NBT = generateVat(true, true); // ← add this

const FIELDS: any = {
  [ModelVersion.AncientMap]: {
    isBeta: true,
    isMapBlock: true,
    shaderFields: ANCIENT_MAP_SHADER_FIELDS,
    hasNormals: false,
    hasBones: false,
    texOffset: 0x58,
    posOffset: 0x5c,
    clrOffset: 0x60,
    texcoordOffset: 0x64,
    shaderOffset: 0x68,
    listOffsets: 0x6c,
    listSizes: 0x70,
    posCount: 0x90,
    clrCount: 0x94,
    texcoordCount: 0x98,
    texCount: 0x99,
    shaderCount: 0x9a,
    dlOffsets: 0x6c,
    dlSizes: 0x70,
    dlInfoCount: 0x99,
    numListBits: 6,
    bitsOffsets: [0x7c],
    bitsByteCounts: [0x86],
    oldVat: true,
    hasYTranslate: false,
  },

  [ModelVersion.Beta]: {
    isBeta: true,
    isMapBlock: false,
    shaderFields: BETA_MODEL_SHADER_FIELDS,
    hasNormals: true,
    hasBones: true,
    texOffset: 0x1c,
    posOffset: 0x24,
    nrmOffset: 0x28, // ???
    clrOffset: 0x2c,
    texcoordOffset: 0x30,
    shaderOffset: 0x34,
    jointOffset: 0x38,
    listOffsets: 0x6c,
    listSizes: 0x70,
    posCount: 0x9e,
    nrmCount: 0xa0,
    clrCount: 0xa2,
    texcoordCount: 0xa4,
    texCount: 0xaa,
    jointCount: 0xab,
    posFineSkinningConfig: 0x64,
    posFineSkinningPieces: 0x80,
    posFineSkinningWeights: 0x84,
    // nrmFineSkinningConfig: 0xac, // ???
    weightCount: 0xad,
    shaderCount: 0xae,
    texMtxCount: 0xaf,
    dlOffsets: 0x88,
    dlSizes: 0x8c,
    dlInfoCount: 0xac,
    numListBits: 6,
    bitsOffsets: [0x90],
    bitsByteCounts: [0x94],
    oldVat: true,
    hasYTranslate: false,
  },

  [ModelVersion.BetaMap]: {
    isBeta: true,
    isMapBlock: true,
    shaderFields: BETA_MAP_SHADER_FIELDS,
    hasNormals: false,
    hasBones: false,
    texOffset: 0x58,
    posOffset: 0x5c,
    clrOffset: 0x60,
    texcoordOffset: 0x64,
    shaderOffset: 0x68,
    listOffsets: 0x6c,
    listSizes: 0x70,
    posCount: 0x9e,
    clrCount: 0xa2,
    texcoordCount: 0xa4,
    texCount: 0x98,
    shaderCount: 0x99, // ???
    texMtxCount: 0xaf,
    dlOffsets: 0x6c,
    dlSizes: 0x70,
    dlInfoCount: 0x99, // ???
    numListBits: 6,
    bitsOffsets: [0x7c],
    bitsByteCounts: [0x94], // ???
    oldVat: true,
    hasYTranslate: false,
  },

  [ModelVersion.Demo]: {
    isMapBlock: false,
    texOffset: 0x20,
    texCount: 0xda, //new! (05)
    posOffset: 0x28,
    posCount: 0xcc, //new
    hasNormals: true,
    nrmOffset: 0x2c,
    nrmCount: 0xce, //new
    clrOffset: 0x30,
    clrCount: 0xd0, // new
    texcoordOffset: 0x34,
    texcoordCount: 0xd2, // new (0732)
    hasBones: true,
    jointOffset: 0x3c,
    jointCount: 0xdb, //NEW
    weightOffset: 0x54,
    weightCount: 0xdc, //NEw
    posFineSkinningConfig: 0x88,
    posFineSkinningPieces: 0xa4,
    posFineSkinningWeights: 0xa8,
    nrmFineSkinningConfig: 0xac,
    shaderOffset: 0x38,
    shaderCount: 0xde, // NEW (might be E0)
    shaderFields: SFADEMO_MODEL_SHADER_FIELDS,
    dlInfoOffset: 0xb8,
    dlInfoCount: 0xc9, //NEW
    dlInfoSize: 0x34,
    numListBits: 8,
    bitsOffsets: [0xbc], // Whoa... (might be BC, then below C0)
    bitsByteCounts: [0xc0],
    oldVat: true,
    hasYTranslate: false,
  },

  [ModelVersion.DemoMap]: {
    isMapBlock: true,
    texOffset: 0x54,
    texCount: 0xa0,
    posOffset: 0x58,
    posCount: 0x90,
    hasNormals: false,
    nrmOffset: 0,
    nrmCount: 0,
    clrOffset: 0x5c,
    clrCount: 0x94,
    texcoordOffset: 0x60,
    texcoordCount: 0x96,
    hasBones: false,
    jointOffset: 0,
    jointCount: 0,
    shaderOffset: 0x64,
    shaderCount: 0xa0, // Polygon attributes and material information
    shaderFields: SFADEMO_MAP_SHADER_FIELDS,
    dlInfoOffset: 0x68,
    dlInfoCount: 0x9f,
    dlInfoSize: 0x34,
    // FIXME: Yet another format occurs in sfademo/frontend!
    // numListBits: 6, // 6 is needed for mod12; 8 is needed for early crfort?!
    numListBits: 8, // ??? should be 6 according to decompilation of demo????
    bitsOffsets: [0x74], // Whoa...
    // FIXME: There are three bitstreams, probably for opaque and transparent objects
    bitsByteCounts: [0x84],
    oldVat: true,
    hasYTranslate: false,
  },

  [ModelVersion.Final]: {
    isFinal: true,
    isMapBlock: false,
    texOffset: 0x20,
    texCount: 0xf2,
    posOffset: 0x28,
    posCount: 0xe4,
    hasNormals: true,
    nrmOffset: 0x2c,
    nrmCount: 0xe6,
    clrOffset: 0x30,
    clrCount: 0xe8,
    texcoordOffset: 0x34,
    texcoordCount: 0xea,
    hasBones: true,
    jointOffset: 0x3c,
    jointCount: 0xf3,
    weightOffset: 0x54,
    weightCount: 0xf4,
    posFineSkinningConfig: 0x88,
    posFineSkinningPieces: 0xa4,
    posFineSkinningWeights: 0xa8,
    nrmFineSkinningConfig: 0xac,
    nrmFineSkinningPieces: 0xc8,
    nrmFineSkinningWeights: 0xcc,
    shaderOffset: 0x38,
    shaderCount: 0xf8,
    shaderFields: SFA_SHADER_FIELDS,
    texMtxCount: 0xfa,
    dlInfoOffset: 0xd0,
    dlInfoCount: 0xf5,
    dlInfoSize: 0x1c,
    numListBits: 8,
    bitsOffsets: [0xd4],
    bitsByteCounts: [0xd8],
    oldVat: false,
    hasYTranslate: false,
  },

  [ModelVersion.FinalMap]: {
    isFinal: true,
    isMapBlock: true,
    texOffset: 0x54,
    texCount: 0xa0,
    posOffset: 0x58,
    posCount: 0x90,
    hasNormals: false,
    nrmOffset: 0,
    nrmCount: 0,
    clrOffset: 0x5c,
    clrCount: 0x94,
    texcoordOffset: 0x60,
    texcoordCount: 0x96,
    hasBones: false,
    jointOffset: 0,
    jointCount: 0,
    shaderOffset: 0x64,
    shaderCount: 0xa2,
    shaderFields: SFA_SHADER_FIELDS,
    dlInfoOffset: 0x68,
    dlInfoCount: 0xa1, // TODO
    dlInfoSize: 0x1c,
    numListBits: 8,
    bitsOffsets: [0x78, 0x7c, 0x80],
    bitsByteCounts: [0x84, 0x86, 0x88],
    oldVat: false,
    hasYTranslate: true,
  },

  [ModelVersion.fear]: {
    isBeta: false,
    isMapBlock: true,
    texOffset: 0x58,
    texCount: 0xa4,
    posOffset: 0x5c,
    posCount: 0x8e,
    hasNormals: false,
    nrmOffset: 0,
    nrmCount: 0,
    clrOffset: 0x60,
    clrCount: 0x92,
    texcoordOffset: 0x64,
    texcoordCount: 0x94,
    hasBones: false,
    jointOffset: 0,
    jointCount: 0,
    shaderOffset: 0x68,
    shaderCount: 0xa6,
    shaderFields: VERY_EARLY_2001,
    dlInfoOffset: 0x6c,
    dlInfoCount: 0xa5, // TODO
    dlInfoSize: 0x34,
    numListBits: 6,
    bitsOffsets: [0x78, 0x80, 0x88],
    bitsByteCounts: [0x7c, 0x84, 0x8c],
    oldVat: true,
    hasYTranslate: false,
  },

  [ModelVersion.dfpt]: {
    isBeta: false,
    isMapBlock: true,
    texOffset: 0x54,
    texCount: 0x9e,
    posOffset: 0x58,
    posCount: 0x8e,
    hasNormals: false,
    nrmOffset: 0,
    nrmCount: 0,
    clrOffset: 0x5c,
    clrCount: 0x92,
    texcoordOffset: 0x60,
    texcoordCount: 0x94,
    hasBones: false,
    jointOffset: 0,
    jointCount: 0,
    shaderOffset: 0x64,
    shaderCount: 0xa0,
    shaderFields: VERY_EARLY_2001,
    dlInfoOffset: 0x68,
    dlInfoCount: 0x9f, // TODO
    dlInfoSize: 0x34,
    numListBits: 6,
    bitsOffsets: [0x74, 0x7c, 0x84],
    bitsByteCounts: [0x86, 0x88, 0x8a],
    oldVat: true,
    hasYTranslate: false,
  },

  [ModelVersion.dup]: {
    isBeta: false,
    isMapBlock: true,
    texOffset: 0x54,
    texCount: 0x9e,
    posOffset: 0x58,
    posCount: 0x8e,
    hasNormals: false,
    nrmOffset: 0,
    nrmCount: 0,
    clrOffset: 0x5c,
    clrCount: 0x92,
    texcoordOffset: 0x60,
    texcoordCount: 0x94,
    hasBones: false,
    jointOffset: 0,
    jointCount: 0,
    shaderOffset: 0x64,
    shaderCount: 0xa0,
    shaderFields: SFADEMO_MAP_SHADER_FIELDS,
    dlInfoOffset: 0x68,
    dlInfoCount: 0x9f, // TODO
    dlInfoSize: 0x34,
    numListBits: 8,
    bitsOffsets: [0x74, 0x7c, 0x84],
    bitsByteCounts: [0x86, 0x88, 0x8a],
    oldVat: true,
    hasYTranslate: false,
  },

  [ModelVersion.Early1]: {
    isBeta: false,
    isMapBlock: true,
    texOffset: 0x54,
    texCount: 0x9e,
    posOffset: 0x58,
    posCount: 0x8e,
    hasNormals: false,
    nrmOffset: 0,
    nrmCount: 0,
    clrOffset: 0x5c,
    clrCount: 0x92,
    texcoordOffset: 0x60,
    texcoordCount: 0x94,
    hasBones: false,
    jointOffset: 0,
    jointCount: 0,
    shaderOffset: 0x64,
    shaderCount: 0xa0,
    shaderFields: SFADEMO_MAP_SHADER_FIELDS,
    dlInfoOffset: 0x68,
    dlInfoCount: 0x9f,
    dlInfoSize: 0x34,
    numListBits: 8,
    bitsOffsets: [0x74, 0x7c, 0x84],
    bitsByteCounts: [0x86, 0x88, 0x8a],
    oldVat: true,
    hasYTranslate: false,
  },

  [ModelVersion.Early2]: {
    isfinal: false,
    isMapBlock: true,
    texOffset: 0x54,
    texCount: 0x9e,
    posOffset: 0x58,
    posCount: 0x8e,
    hasNormals: false,
    nrmOffset: 0,
    nrmCount: 0,
    clrOffset: 0x5c,
    clrCount: 0x92,
    texcoordOffset: 0x60,
    texcoordCount: 0x94,
    hasBones: false,
    jointOffset: 0,
    jointCount: 0,
    shaderOffset: 0x64,
    shaderCount: 0xa0,
    shaderFields: EARLY2_MAP_SHADER_FIELDS,
    dlInfoOffset: 0x68,
    dlInfoCount: 0x9f, // TODO
    dlInfoSize: 0x38,
    numListBits: 8,
    bitsOffsets: [0x74, 0x7c, 0x84],
    bitsByteCounts: [0x84, 0x86, 0x88],
    oldVat: true,
    hasYTranslate: false,
  },

  [ModelVersion.Early3]: {
    isFinal: false,
    isMapBlock: true,
    texOffset: 0x54,
    texCount: 0x9e,
    posOffset: 0x58,
    posCount: 0x8e,
    hasNormals: false,
    nrmOffset: 0,
    nrmCount: 0,
    clrOffset: 0x5c,
    clrCount: 0x92,
    texcoordOffset: 0x60,
    texcoordCount: 0x94,
    hasBones: false,
    jointOffset: 0,
    jointCount: 0,
    shaderOffset: 0x64,
    shaderCount: 0xa0,
    shaderFields: EARLY3_MAP_SHADER_FIELDS,
    dlInfoOffset: 0x68,
    dlInfoCount: 0x9f, // TODO
    dlInfoSize: 0x38,
    numListBits: 8,
    bitsOffsets: [0x78, 0x7c, 0x80],
    bitsByteCounts: [0x84, 0x86, 0x88],
    oldVat: true,
    hasYTranslate: false,
  },

  [ModelVersion.Early4]: {
    isFinal: false,
    isMapBlock: true,
    texOffset: 0x54,
    texCount: 0x9e,
    posOffset: 0x58,
    posCount: 0x8e,
    hasNormals: false,
    nrmOffset: 0,
    nrmCount: 0,
    clrOffset: 0x5c,
    clrCount: 0x92,
    texcoordOffset: 0x60,
    texcoordCount: 0x94,
    hasBones: false,
    jointOffset: 0,
    jointCount: 0,
    shaderOffset: 0x64,
    shaderCount: 0xa0,
    shaderFields: SFA_SHADER_FIELDS,
    dlInfoOffset: 0x68,
    dlInfoCount: 0x9f, // TODO
    dlInfoSize: 0x38,
    numListBits: 8,
    bitsOffsets: [0x78, 0x7c, 0x80],
    bitsByteCounts: [0x84, 0x86, 0x88],
    oldVat: true,
    hasYTranslate: false,
  },
};

const enum Opcode {
  SetShader = 1,
  CallDL = 2,
  SetVCD = 3,
  SetMatrices = 4,
  End = 5,
}

function dumpRawBytes(data: DataView, byteCount: number = 256) {
  const bytesPerRow = 16;
  for (let offset = 0; offset < byteCount; offset += bytesPerRow) {
    const rowBytes = [] as string[];
    for (let i = 0; i < bytesPerRow; i++) {
      if (offset + i < data.byteLength) {
        rowBytes.push(data.getUint8(offset + i).toString(16).padStart(2, '0'));
      } else {
        rowBytes.push(' ');
      }
    }
    // console.log(`0x${offset.toString(16).padStart(4, '0')}: ${rowBytes.join(' ')}`);
  }
}

export function loadModel(
  data: DataView,
  texFetcher: TextureFetcher,
  materialFactory: MaterialFactory,
  version: ModelVersion,
): Model {
  dumpRawBytes(data, 256);
  const model = new Model(version);
  let fields = FIELDS[version];

  const totalMapByteLength = data.buffer.byteLength;
  //console.warn('[DEBUG] totalMapByteLength =', totalMapByteLength);
  if (version === ModelVersion.Early1 && totalMapByteLength === 144448) {
    fields = { ...fields };
    fields.numListBits = 6;
    // console.warn('[PATCH] Detected full cloudtreasure map (144448 bytes) → numListBits = 6');
  }

  function logAllFields(data: DataView, fields: any) {
   // console.log('--- Detailed Dumping model fields ---');
    // Do NOT attempt to read these from the file; they are immediate constants in the table.
    const IMMEDIATE_KEYS = new Set<string>([
      'numListBits','dlInfoSize','isMapBlock','isFinal','isBeta','oldVat',
      'hasNormals','hasBones','hasYTranslate','isfinal','shaderFields'
    ]);

    for (const key in fields) {
      if (IMMEDIATE_KEYS.has(key)) {
      //  console.log(`${key} (immediate): ${fields[key]}`);
        continue;
      }
      const offset = fields[key];
      if (typeof offset === 'number' && offset >= 0 && offset < data.byteLength) {
        try {
          let length: number;
          let val: number;
          if (key === 'jointCount' || key === 'weightCount' || key === 'shaderCount' || key === 'dlInfoCount') {
            length = 1;
            val = data.getUint8(offset);
          } else if (/Count$|Size$/i.test(key)) {
            length = 2;
            val = offset + 1 < data.byteLength ? data.getUint16(offset, false) : 0;
          } else if (/Offset$|posFineSkinning|nrmFineSkinning|shaderOffset|dlInfoOffset|bitsOffsets/i.test(key)) {
            length = 4;
            val = offset + 3 < data.byteLength ? data.getUint32(offset, false) : 0;
          } else {
            length = 1;
            val = data.getUint8(offset);
          }
          const bytes: string[] = [];
          for (let i = 0; i < length; i++) {
            if (offset + i < data.byteLength)
              bytes.push(data.getUint8(offset + i).toString(16).padStart(2, '0'));
            else
              bytes.push('??');
          }
         // console.log(`${key} raw bytes @ 0x${offset.toString(16)}: ${bytes.join(' ')} => ${val}`);
        } catch (e) {
        //  console.warn(`Error reading field ${key} at offset 0x${offset.toString(16)}`, e);
        }
      }
    }
    // console.log('--- End detailed dump ---');
  }

  logAllFields(data, fields);

  // ===== PROBE #1: shader table boundaries & stride =====
  const FILE_LEN = data.byteLength;
  const shaderOff = data.getUint32(fields.shaderOffset);
  const shaderCnt = data.getUint8(fields.shaderCount);
  const dlInfoOff = data.getUint32(fields.dlInfoOffset);
  const bits0Off = (fields.bitsOffsets?.length ?? 0) > 0 ? data.getUint32(fields.bitsOffsets[0]) : 0;
  //.warn(
   // `[PROBE1] shaderOff=0x${shaderOff.toString(16)} shaderCnt=${shaderCnt} dlInfoOff=0x${dlInfoOff.toString(16)} bits0Off=0x${bits0Off.toString(16)} fileLen=0x${FILE_LEN.toString(16)}`
//  );

  // Candidate: shader table is contiguous up to the start of dlInfo.
  let shaderSpan = (dlInfoOff > shaderOff && shaderCnt) ? (dlInfoOff - shaderOff) : 0;
  let shaderStride = shaderCnt ? Math.floor(shaderSpan / shaderCnt) : 0;
  let shaderRema = shaderCnt ? (shaderSpan % shaderCnt) : 0;
 // console.warn(`[PROBE1] shaderStrideCandidate=${shaderStride} (0x${shaderStride.toString(16)}) remainder=${shaderRema}`);

  // Quick peek at first two shader entries using that stride (just dump first 16 bytes of each).
  for (let i = 0; i < Math.min(shaderCnt, 2); i++) {
    const base = shaderOff + i * shaderStride;
    const row: string[] = [];
    for (let b = 0; b < 16 && base + b < FILE_LEN; b++) {
      row.push(data.getUint8(base + b).toString(16).padStart(2, '0'));
    }
   // console.warn(`[PROBE1] shader[${i}] @0x${base.toString(16)}: ${row.join(' ')}`);
  }

  // ===== PROBE #2: try dlInfo sizes and score plausibility =====
  const dlCnt = data.getUint8(fields.dlInfoCount);
  const dlBase = dlInfoOff;
  // Known strides used across SFA builds to test:
  const dlStrideCandidates = [0x1C, 0x20, 0x24, 0x28, 0x30, 0x34, 0x38, 0x3C, 0x40];

  function readDl(off: number, stride: number) {
    // Current Demo guess: offset @ +0x00 (u32 BE), size @ +0x04 (u16 BE).
    const o = data.getUint32(off, false);
    const s = data.getUint16(off + 0x04, false);
    return { o, s };
  }

  for (const stride of dlStrideCandidates) {
    if (!dlBase || dlBase + stride * dlCnt > FILE_LEN) {
    //  console.warn(`[PROBE2] dlInfoStride=0x${stride.toString(16)} -> table OOB (base too large or count*stride too big)`);
      continue;
    }
    let ok = 0, bad = 0;
    const samples: string[] = [];
    const sampleN = Math.min(3, dlCnt);
    for (let i = 0; i < dlCnt; i++) {
      const e = readDl(dlBase + i * stride, stride);
      const sane = e.o > 0 && e.s > 0 && (e.o + e.s) <= FILE_LEN;
      if (i < sampleN) samples.push(`#${i}:off=0x${e.o.toString(16)},size=0x${e.s.toString(16)}`);
      sane ? ok++ : bad++;
    }
   // console.warn(
   //   `[PROBE2] dlInfoStride=0x${stride.toString(16)} score ok=${ok}/${dlCnt} bad=${bad} samples=[${samples.join(' | ')}]`
   // );
  }

  // ===== PROBE #3: hex peek of dlInfo head =====
  if (dlBase && dlBase < FILE_LEN) {
    const dumpLen = Math.min(0x80, FILE_LEN - dlBase);
    let line = '';
    for (let i = 0; i < dumpLen; i++) {
      const b = data.getUint8(dlBase + i).toString(16).padStart(2,'0');
      line += b + (i % 16 === 15 ? ` @+0x${(i-15).toString(16)}\n` : ' ');
    }
   // console.warn(`[PROBE3] dlInfo head @0x${dlBase.toString(16)} (first ${dumpLen} bytes)\n${line}`);
  }

  const normalFlags = fields.hasNormals ? data.getUint8(0x24) : 0;
  model.isMapBlock = !!fields.isMapBlock;

  // Read raw bytes of posCount field (2 bytes)
  const posOffset = data.getUint32(fields.posOffset);
  const posCount = data.getUint16(fields.posCount);
//  console.log(`Loading ${posCount} positions from 0x${posOffset.toString(16)}`);
  model.originalPosBuffer = dataSubarray(data, posOffset);

  if (fields.hasNormals) {
    const nrmOffset = data.getUint32(fields.nrmOffset);
    const nrmCount = data.getUint16(fields.nrmCount);
   // console.log(`Loading ${nrmCount} normals from 0x${nrmOffset.toString(16)}`);
    model.originalNrmBuffer = dataSubarray(data, nrmOffset, nrmCount * ((normalFlags & NormalFlags.NBT) ? 9 : 3));
  }

  // --- Guard: some demo objects advertise fewer normals than are indexed ---
  // If normals are present but the buffer is smaller than a 1:1 map with POS,
  // pad by repeating the last normal so indices don’t run OOB in the VTX loader.
  if (fields.hasNormals && model.originalNrmBuffer.byteLength > 0) {
    const nrmStride = (normalFlags & NormalFlags.NBT) ? 9 : 3;
    const needed = (data.getUint16(fields.posCount) >>> 0) * nrmStride;
    if (model.originalNrmBuffer.byteLength < needed) {
      const src = new Uint8Array(model.originalNrmBuffer.buffer, model.originalNrmBuffer.byteOffset, model.originalNrmBuffer.byteLength);
      const dst = new Uint8Array(needed);
      dst.set(src);
      const tailStart = Math.max(0, src.byteLength - nrmStride);
      for (let off = src.byteLength; off < needed; off += nrmStride) {
        for (let j = 0; j < nrmStride; j++) dst[off + j] = src[tailStart + j] ?? 0;
      }
      model.originalNrmBuffer = new DataView(dst.buffer);
     // console.warn(`[NRM_PAD] grew normals ${src.byteLength} -> ${needed} (stride=${nrmStride})`);
    }
  }

  if (fields.posFineSkinningConfig !== undefined) {
    const posFineSkinningConfig = parseFineSkinningConfig(dataSubarray(data, fields.posFineSkinningConfig));
    if (posFineSkinningConfig.numPieces !== 0) {
      model.hasFineSkinning = true;
      model.fineSkinPositionQuantizeScale = posFineSkinningConfig.quantizeScale;

      const weightsOffs = data.getUint32(fields.posFineSkinningWeights);
      const posFineSkinningWeights = dataSubarray(data, weightsOffs);
      const piecesOffs = data.getUint32(fields.posFineSkinningPieces);

      for (let i = 0; i < posFineSkinningConfig.numPieces; i++) {
        const piece = parseFineSkinningPiece(dataSubarray(data, piecesOffs + i * FineSkinningPiece_SIZE, FineSkinningPiece_SIZE));
        model.posFineSkins.push({
          vertexCount: piece.numVertices,
          bufferOffset: piece.skinDataSrcOffs + piece.skinMeOffset,
          bone0: piece.bone0,
          bone1: piece.bone1,
          weights: dataSubarray(posFineSkinningWeights, piece.weightsSrc, piece.weightsBlockCount * 32),
        });
      }
    }

    const nrmFineSkinningConfig = parseFineSkinningConfig(dataSubarray(data, fields.nrmFineSkinningConfig));
    if (
      nrmFineSkinningConfig.numPieces !== 0 &&
      fields.nrmFineSkinningPieces !== undefined &&
      fields.nrmFineSkinningWeights !== undefined
    ) {
      model.hasFineSkinning = true;
      model.fineSkinNormalQuantizeScale = nrmFineSkinningConfig.quantizeScale;
      model.fineSkinNBTNormals = !!(normalFlags & NormalFlags.NBT);
      if (model.fineSkinNBTNormals)
       console.warn('Fine-skinned NBT normals detected; not implemented yet');

      const weightsOffs = data.getUint32(fields.nrmFineSkinningWeights);
      const piecesOffs = data.getUint32(fields.nrmFineSkinningPieces);

      // Bounds guards — some Demo files advertise pieces but tables are missing.
      const weightsInBounds = weightsOffs > 0 && weightsOffs < data.byteLength;
      const piecesInBounds = piecesOffs > 0 && (piecesOffs + nrmFineSkinningConfig.numPieces * FineSkinningPiece_SIZE) <= data.byteLength;

      if (weightsInBounds && piecesInBounds) {
        const nrmFineSkinningWeights = dataSubarray(data, weightsOffs);
        for (let i = 0; i < nrmFineSkinningConfig.numPieces; i++) {
          const piece = parseFineSkinningPiece(dataSubarray(data, piecesOffs + i * FineSkinningPiece_SIZE, FineSkinningPiece_SIZE));
          model.nrmFineSkins.push({
            vertexCount: piece.numVertices,
            bufferOffset: piece.skinDataSrcOffs + piece.skinMeOffset,
            bone0: piece.bone0,
            bone1: piece.bone1,
            weights: dataSubarray(nrmFineSkinningWeights, piece.weightsSrc, piece.weightsBlockCount * 32),
          });
        }
      } else {
     //   console.log('Skipping normals fine skinning: weights or pieces table out-of-bounds/missing (Demo).');
      }
    } else if (nrmFineSkinningConfig.numPieces !== 0) {
    //  console.log('Skipping normals fine skinning: Demo fields missing pieces/weights offsets.');
    }

    model.hasBetaFineSkinning = model.hasFineSkinning && version === ModelVersion.Beta;
  }

  // Pick base VAT and deep-clone so tweaks don’t leak across models
  const baseVat = (normalFlags & NormalFlags.NBT)
    ? (fields.oldVat ? OLD_VAT_NBT : VAT_NBT)
    : (fields.oldVat ? OLD_VAT : VAT);

  const vat: GX_VtxAttrFmt[][] = baseVat.map(row => row.map(fmt => ({
    compType: fmt.compType,
    compShift: fmt.compShift,
    compCnt: fmt.compCnt,
  })));

  // Old (Demo/Beta) **object** models that use NBT need POS 1/8 quantization to avoid “exploded” geometry.
  if (fields.oldVat && !fields.isMapBlock && (normalFlags & NormalFlags.NBT)) {
    for (const r of [5, 6, 7])
      vat[r][GX.Attr.POS].compShift = 3;
  }
 // console.warn(
  //  `[VAT_PICK] oldVat=${!!fields.oldVat} nrmNBT=${!!(normalFlags & NormalFlags.NBT)} -> vatRow5: POS.shift=${vat[5][GX.Attr.POS].compShift} NRM.compType=${vat[5][GX.Attr.NRM].compType}`
  //);

  // Early3/Early4 maps: Their vertex color is 16-bit RGBA4. Ensure VAT expects RGBA4 on all streams.
  const isEarly34Map = !!fields.isMapBlock && (version === ModelVersion.Early3 || version === ModelVersion.Early4);
  if (isEarly34Map) {
    for (let i = 0; i < 8; i++) {
      vat[i][GX.Attr.CLR0].compType = GX.CompType.RGBA4;
      vat[i][GX.Attr.CLR0].compCnt = GX.CompCnt.CLR_RGBA;
      (vat[i][GX.Attr.CLR0] as any).compShift = 0;
    }
  }

  // @0x8: data size
  // @0xc: 4x3 matrix (placeholder; always zeroed in files)
  // @0x8e: y translation (up/down)
  const texOffset = data.getUint32(fields.texOffset);
  const texCount = data.getUint8(fields.texCount);
  //console.log(`Loading ${texCount} texture infos from 0x${texOffset.toString(16)}`);
  const texIds: number[] = [];
  for (let i = 0; i < texCount; i++) {
    const texIdFromFile = readUint32(data, texOffset, i);
    texIds.push(texIdFromFile);
  }
  //console.log(`texids: ${texIds}`);

  // Declare color offset and count first
  const clrOffset = data.getUint32(fields.clrOffset);
  const clrCount = data.getUint16(fields.clrCount);
  //console.log(`Loading ${clrCount} colors from 0x${clrOffset.toString(16)}`);
  let clrBuffer: Uint8Array;
  if (version === ModelVersion.AncientMap) {
    clrBuffer = ArrayBufferSlice.fromView(dataSubarray(data, clrOffset)).createTypedArray(Uint8Array);
  } else {
    const bytesAvail = Math.max(0, data.byteLength - clrOffset);
    const safeClrCount = Math.min(clrCount, bytesAvail >>> 1);
    clrBuffer = ArrayBufferSlice.fromView(dataSubarray(data, clrOffset, safeClrCount * 2)).createTypedArray(Uint8Array);
  }

  let clrBufferForArrays = clrBuffer;
  if (isEarly34Map) {
    const palBytes = clrBuffer;
    const palCount = palBytes.byteLength >>> 1;
    const dst = new Uint8Array(0x10000 * 2);
    const mask = (palCount <= 0x0100) ? 0x00FF : (palCount <= 0x1000) ? 0x0FFF : -1 as number;
    for (let idx = 0; idx < 0x10000; idx++) {
      let i = idx & 0x7FFF;
      if (mask !== -1) {
        i &= mask;
      } else if (palCount) {
        i %= palCount;
      }
      const s = i << 1;
      const d = idx << 1;
      dst[d] = palBytes[s];
      dst[d + 1] = palBytes[s + 1];
    }
    clrBufferForArrays = dst;
  }


let usingDummyClr = false;

if (fields.isMapBlock && clrBufferForArrays.byteLength === 0) {
  const dst = new Uint8Array(0x10000 * 2);
  dst.fill(0xFF);
  clrBufferForArrays = dst;
  usingDummyClr = true;
}


  const hasColorTable = clrBufferForArrays.byteLength > 0;

  const texcoordOffset = data.getUint32(fields.texcoordOffset);
  const texcoordCount = data.getUint16(fields.texcoordCount);
//  console.log(`Loading ${texcoordCount} texcoords from 0x${texcoordOffset.toString(16)}`);
  const texcoordBuffer = dataSubarray(data, texcoordOffset);

  let hasSkinning = false;
  let jointCount = 0;
  if (fields.hasBones) {
    const jointOffset = data.getUint32(fields.jointOffset);
    jointCount = data.getUint8(fields.jointCount);
   // console.log(`Loading ${jointCount} joints from offset 0x${jointOffset.toString(16)}`);
    hasSkinning = jointCount > 0; // ← IMPORTANT: don’t enable skinning with 0 joints.

    model.joints = [];
    if (jointCount > 0) {
      let offs = jointOffset;
      for (let i = 0; i < jointCount; i++) {
        model.joints.push({
          parent: data.getUint8(offs),
          boneNum: data.getUint8(offs + 0x1) & 0x7f,
          translation: readVec3(data, offs + 0x4),
          bindTranslation: readVec3(data, offs + 0x10),
        });
        offs += 0x1c;
      }

      if (fields.weightOffset !== undefined) {
        const weightOffset = data.getUint32(fields.weightOffset);
        const weightCount = data.getUint8(fields.weightCount);
        // Guard: many demo objects have weightCount set but the table is not present (offset 0).
        // Also guard bounds to avoid reading random memory when values are junk.
        const bytesNeeded = weightCount * 4; // each weight record is 4 bytes
        const inBounds = (weightOffset > 0) && (weightOffset + bytesNeeded) <= data.byteLength;
        if (weightCount > 0 && inBounds) {
         // console.log(`Loading ${weightCount} weights from offset 0x${weightOffset.toString(16)}`);
          model.coarseBlends = [];
          let offs = weightOffset;
          for (let i = 0; i < weightCount; i++) {
            const split = data.getUint8(offs + 0x2);
            const influence0 = 0.25 * split;
            model.coarseBlends.push({
              joint0: data.getUint8(offs),
              joint1: data.getUint8(offs + 0x1),
              influence0,
              influence1: 1 - influence0,
            });
            offs += 0x4;
          }
        } else {
         // console.log(`Skipping weights: count=${weightCount}, offset=0x${weightOffset.toString(16)} (not present / OOB)`);
        }
      }

      model.skeleton = new Skeleton();
      model.invBindTranslations = nArray(model.joints.length, () => vec3.create());
      for (let i = 0; i < model.joints.length; i++) {
        const joint = model.joints[i];
        if (joint.boneNum !== i) throw Error("wtf? joint's bone number doesn't match its index!");
        model.skeleton.addJoint(joint.parent != 0xff ? joint.parent : undefined, joint.translation);
        vec3.negate(model.invBindTranslations[i], joint.bindTranslation);
      }
    }
  }

  if (!fields.isMapBlock && fields.isFinal) {
    model.cullRadius = data.getUint16(0xe0);
    model.lightFlags = data.getUint16(0xe2);
  }

  let texMtxCount = 0;
  // Only formats that actually have this header field should read it.
  // Demo/Beta don't define texMtxCount, and reading at undefined => 0x00
  // would corrupt the VCD by adding tons of TEXMTXIDX DIRECT attrs.
  if (fields.hasBones && fields.texMtxCount !== undefined)
    texMtxCount = data.getUint8(fields.texMtxCount);
  //console.warn(`[TEXMTX] texMtxCount=${texMtxCount}`);

  // Debug dump bytes in a range (adjust range as needed)
  for (let off = 0x00; off < 0x150; off++) {
   // console.log(`0x${off.toString(16)}: 0x${data.getUint8(off).toString(16)}`);
  }

  const shaderOffset = data.getUint32(fields.shaderOffset);
  const shaderCount = data.getUint8(fields.shaderCount);
  //console.log(`Loading ${shaderCount} shaders from offset 0x${shaderOffset.toString(16)}`);

  const shaders: Shader[] = [];
  let offs = shaderOffset;
  for (let i = 0; i < shaderCount; i++) {
    const shaderBin = dataSubarray(data, offs, fields.shaderFields.size);
    shaders.push(
      parseShader(
        shaderBin,
        fields.shaderFields,
        texIds,
        normalFlags,
        model.lightFlags,
        texMtxCount,
      ),
    );
    offs += fields.shaderFields.size;
  }

  model.materials = [];

  const dlInfos: DisplayListInfo[] = [];
  const dlInfoCount = data.getUint8(fields.dlInfoCount);
//  console.log(`Loading ${dlInfoCount} display lists...`);

  if (fields.isBeta) {
    for (let i = 0; i < dlInfoCount; i++) {
      const dlOffsetsOffs = data.getUint32(fields.dlOffsets);
      const dlSizesOffs = data.getUint32(fields.dlSizes);
      dlInfos.push({
        offset: readUint32(data, dlOffsetsOffs, i),
        size: readUint16(data, dlSizesOffs, i),
      });
    }
  } else {
    const dlInfoOffset = data.getUint32(fields.dlInfoOffset);
    if (dlInfoOffset === 0 || dlInfoOffset >= data.byteLength) {
     // console.warn(`DL info table missing or OOB: offset=0x${dlInfoOffset.toString(16)} (Demo/object)`);
    } else {
      const fileLen = data.byteLength >>> 0;
      const stride = fields.dlInfoSize >>> 0;
      const bytesAvail = fileLen - dlInfoOffset;
      const maxBySize = Math.floor(bytesAvail / stride);
      const effSlots = Math.max(0, Math.min(dlInfoCount, maxBySize));

      // IMPORTANT: preserve indices — pre-size the array to dlInfoCount.
      // Fill with empty sentinels first.
      for (let i = 0; i < dlInfoCount; i++)
        dlInfos[i] = { offset: 0, size: 0 } as DisplayListInfo;

      let consecutiveInvalid = 0;
      const INVALID_RUN_STOP = 8; // table tail padding heuristic

      for (let i = 0; i < effSlots; i++) {
        const rowOff = dlInfoOffset + i * stride;
        if ((rowOff + stride) > fileLen) {
          consecutiveInvalid++;
          continue;
        }
        const rowDV = dataSubarray(data, rowOff, stride);
        const info = parseDisplayListInfo(rowDV);
        const ok = info.offset > 0 && info.size > 0 && (info.offset + info.size) <= fileLen;
        if (ok) {
          dlInfos[i] = info;
          consecutiveInvalid = 0;
        } else {
          // keep the empty sentinel in place
          consecutiveInvalid++;
        }
        // If we’ve walked into a big padded tail, stop early.
        if (consecutiveInvalid >= INVALID_RUN_STOP) {
          // leave remaining slots as empty sentinels
          break;
        }
      }
    }
  }

  // --- DL table sanity ---
  for (let i = 0; i < dlInfos.length; i++) {
    const { offset, size } = dlInfos[i];
    if (offset === 0 || size === 0) {
     // console.warn(`[DL_SANITY] #${i} empty offset/size (offset=0x${offset.toString(16)}, size=0x${size.toString(16)})`);
    }
    if (offset < 0 || offset + size > data.byteLength) {
     // console.error(`[DL_OOB] #${i} offset=0x${offset.toString(16)} size=0x${size.toString(16)} > fileLen=0x${data.byteLength.toString(16)}`);
    }
  }
 // console.warn(`[DL_SUMMARY] count=${dlInfos.length} dlInfoSize(field)=${fields.dlInfoSize}`);

  const bitsOffsets: number[] = [];
  const bitsByteCounts: number[] = [];
  for (let i = 0; i < fields.bitsOffsets.length; i++) {
    bitsOffsets.push(data.getUint32(fields.bitsOffsets[i]));
    bitsByteCounts.push(data.getUint16(fields.bitsByteCounts[i]));
  }

  if (fields.hasYTranslate)
    model.modelTranslate[1] = data.getInt16(0x8e);

  const pnMatrixMap: number[] = nArray(10, () => 0);

  const getVtxArrays = (posBuffer: DataView, nrmBuffer?: DataView) => {
    const vtxArrays: GX_Array[] = [] as any;
    vtxArrays[GX.Attr.POS] = { buffer: ArrayBufferSlice.fromView(posBuffer), offs: 0, stride: 6 };
    if (fields.hasNormals)
      vtxArrays[GX.Attr.NRM] = { buffer: ArrayBufferSlice.fromView(nrmBuffer!), offs: 0, stride: (normalFlags & NormalFlags.NBT) ? 9 : 3 };
    vtxArrays[GX.Attr.CLR0] = { buffer: ArrayBufferSlice.fromView(clrBufferForArrays), offs: 0, stride: 2 };
    for (let t = 0; t < 8; t++)
      vtxArrays[GX.Attr.TEX0 + t] = { buffer: ArrayBufferSlice.fromView(texcoordBuffer), offs: 0, stride: 4 };
    return vtxArrays;
  };

  const readVertexDesc = (bits: LowBitReader, shader: Shader): GX_VtxDesc[] => {
    //console.log('Setting descriptor');
    const vcd: GX_VtxDesc[] = [] as any;
    for (let i = 0; i <= GX.Attr.MAX; i++) vcd[i] = { type: GX.AttrType.NONE };

      if (fields.hasBones && jointCount >= 2) {
      vcd[GX.Attr.PNMTXIDX].type = GX.AttrType.DIRECT;
      let texmtxNum = 0;
      if (shader.hasHemisphericProbe || shader.hasReflectiveProbe) {
        if (shader.hasNBTTexture) {
          // Binormal matrix index
          vcd[GX.Attr.TEX0MTXIDX + texmtxNum].type = GX.AttrType.DIRECT;
          texmtxNum++;
          // Tangent matrix index
          vcd[GX.Attr.TEX0MTXIDX + texmtxNum].type = GX.AttrType.DIRECT;
          texmtxNum++;
        }
        // Normal matrix index
        vcd[GX.Attr.TEX0MTXIDX + texmtxNum].type = GX.AttrType.DIRECT;
        texmtxNum++;
      }

      // Object-space texture matrices packed from the end (7..0)
      texmtxNum = 7;
      for (let i = 0; i < texMtxCount; i++) {
        vcd[GX.Attr.TEX0MTXIDX + texmtxNum].type = GX.AttrType.DIRECT;
        texmtxNum--;
      }
    }

    // POS
    vcd[GX.Attr.POS].type = bits.get(1) ? GX.AttrType.INDEX16 : GX.AttrType.INDEX8;

    // NRM
    if (fields.hasNormals && (shader.attrFlags & ShaderAttrFlags.NRM))
      vcd[GX.Attr.NRM].type = bits.get(1) ? GX.AttrType.INDEX16 : GX.AttrType.INDEX8;
    else
      vcd[GX.Attr.NRM].type = GX.AttrType.NONE;

    // Colors:
    // Early/Demo map bitstreams still encode the CLR0 size bit even when the shader doesn't use color.
    // If we skip it, the stream desyncs. Consume it whenever a palette is present on maps.
    const mapHasPalette = hasColorTable && !!fields.isMapBlock;
    const wantClr0 = mapHasPalette || !!(shader.attrFlags & ShaderAttrFlags.CLR);
    if (wantClr0) {
      if (isEarly34Map) {
        // Early3/4 maps force CLR as INDEX16 but still encode one size bit — consume it to keep alignment.
        bits.get(1);
        vcd[GX.Attr.CLR0].type = GX.AttrType.INDEX16;
      } else {
        vcd[GX.Attr.CLR0].type = bits.get(1) ? GX.AttrType.INDEX16 : GX.AttrType.INDEX8;
      }
    } else {
      vcd[GX.Attr.CLR0].type = GX.AttrType.NONE;
    }

    // TEX coords (one size bit applies to all present layers)
    if (shader.layers.length > 0) {
      const texCoordDesc = bits.get(1);
      for (let t = 0; t < 8; t++) {
        if (t < shader.layers.length)
          vcd[GX.Attr.TEX0 + t].type = texCoordDesc ? GX.AttrType.INDEX16 : GX.AttrType.INDEX8;
        else
          vcd[GX.Attr.TEX0 + t].type = GX.AttrType.NONE;
      }
    } else {
      for (let t = 0; t < 8; t++)
        vcd[GX.Attr.TEX0 + t].type = GX.AttrType.NONE;
    }

    // DEMO/BETA quirk: command reader aligns to next byte after the VCD group.
    if (fields.oldVat) {
      const misalign = (bits.bitIndex & 7);
      if (misalign) bits.drop(8 - misalign);
    }

    return vcd;
  };

  const runSpecialBitstream = (
    bitsOffset: number,
    bitAddress: number,
    buildSpecialMaterial: BuildMaterialFunc,
    posBuffer: DataView,
    nrmBuffer?: DataView,
  ): Shape => {
   // console.log(`running special bitstream at offset 0x${bitsOffset.toString(16)} bit-address 0x${bitAddress.toString(16)}`);
    const bits = new LowBitReader(data, bitsOffset);
    bits.seekBit(bitAddress);

    bits.drop(4);
    const shaderNum = bits.get(6);
    const shader = shaders[shaderNum];
    const material = buildSpecialMaterial(shader, texFetcher, texIds, fields.isMapBlock);

    bits.drop(4);
    const vcd = readVertexDesc(bits, shader);

    bits.drop(4);
    const num = bits.get(4);
    for (let i = 0; i < num; i++)
      bits.drop(8);

    bits.drop(4);
    const listNum = bits.get(fields.numListBits);
    const dlInfo = dlInfos[listNum];

   // console.log(`Calling special bitstream DL #${listNum} at offset 0x${dlInfo.offset.toString(16)}, size 0x${dlInfo.size.toString(16)}`);

    const displayList = dataSubarray(data, dlInfo.offset, dlInfo.size);
    const vtxArrays = getVtxArrays(posBuffer, nrmBuffer);
    const newGeom = new ShapeGeometry(vtxArrays, vcd, vat, displayList, model.hasFineSkinning);
    newGeom.setPnMatrixMap(pnMatrixMap, hasSkinning, model.hasFineSkinning);

    if (dlInfo.aabb !== undefined)
      newGeom.setBoundingBox(dlInfo.aabb);
    if (dlInfo.sortLayer !== undefined)
      newGeom.setSortLayer(dlInfo.sortLayer);

    return new Shape(newGeom, new ShapeMaterial(material), false);
  };

  const runSpecialBitstreamMulti = (
    bitsOffset: number,
    bitAddress: number,
    buildSpecialMaterial: BuildMaterialFunc,
    posBuffer: DataView,
    nrmBuffer: DataView | undefined,
    fallbackVcd: GX_VtxDesc[],
    shouldKeepShader: (shader: Shader) => boolean,
  ): Shape[] => {
    const out: Shape[] = [];
    const bits = new LowBitReader(data, bitsOffset);
    bits.seekBit(bitAddress);

    let locShader = shaders[0];
    let locMaterial = buildSpecialMaterial(locShader, texFetcher, texIds, fields.isMapBlock);
    let locVcd: GX_VtxDesc[] = fallbackVcd.slice();
    let done = false;

    while (!done) {
      const op = bits.get(4);
      switch (op) {
        case Opcode.SetShader: {
          const shaderNum = bits.get(6);
          locShader = shaders[shaderNum];
          locMaterial = buildSpecialMaterial(locShader, texFetcher, texIds, fields.isMapBlock);
          break;
        }
        case Opcode.SetVCD: {
          locVcd = readVertexDesc(bits, locShader);
          break;
        }
        case Opcode.SetMatrices: {
          const numBones = bits.get(4);
          for (let i = 0; i < numBones; i++)
            bits.get(8);
          break;
        }
        case Opcode.CallDL: {
          const listNum = bits.get(fields.numListBits);
          if (listNum >= dlInfos.length) break;
          if (!shouldKeepShader(locShader)) break;

          const dlInfo = dlInfos[listNum];
          const displayList = dataSubarray(data, dlInfo.offset, dlInfo.size);
          const vtxArrays = getVtxArrays(posBuffer, nrmBuffer);

          const geom = new ShapeGeometry(vtxArrays, locVcd, vat, displayList, model.hasFineSkinning);
          geom.setPnMatrixMap(pnMatrixMap, hasSkinning, model.hasFineSkinning);
          if (dlInfo.aabb !== undefined) geom.setBoundingBox(dlInfo.aabb);
          if (dlInfo.sortLayer !== undefined) geom.setSortLayer(dlInfo.sortLayer);

          out.push(new Shape(geom, new ShapeMaterial(locMaterial), false));
          break;
        }
        case Opcode.End:
          done = true;
          break;
        default:
          done = true;
          break;
      }
    }
    return out;
  };

  // === VCD/DL STRIDE FORCE (robust) ===
  function isLikelyGXOpcode(b: number): boolean {
    // BP write (0x61), small CP/XF-ish (0x08/0x10/0x20/0x40), and GX draws 0x80..0x9F
    return b === 0x61 || b === 0x08 || b === 0x10 || b === 0x20 || b === 0x40 || (b >= 0x80 && b <= 0x9f);
  }

  function vcdClone(vcd: GX_VtxDesc[]): GX_VtxDesc[] {
    return vcd.map(x => ({ type: x?.type ?? GX.AttrType.NONE }));
  }

  function vcdIndexBytes(vcd: GX_VtxDesc[]): number {
    const b = (a: number) =>
      vcd[a]?.type === GX.AttrType.INDEX16 ? 2 :
      vcd[a]?.type === GX.AttrType.INDEX8  ? 1 : 0;

    return b(GX.Attr.POS) + b(GX.Attr.NRM) + b(GX.Attr.CLR0) + b(GX.Attr.TEX0) + b(GX.Attr.TEX1) + b(GX.Attr.TEX2) + b(GX.Attr.TEX3);
  }

  function vcdDirectBytes(vcd: GX_VtxDesc[]): number {
    let d = 0;
    if (vcd[GX.Attr.PNMTXIDX]?.type === GX.AttrType.DIRECT) d++;
    for (let i = 0; i < 8; i++)
      if (vcd[GX.Attr.TEX0MTXIDX + i]?.type === GX.AttrType.DIRECT) d++;
    return d;
  }

  function guessTargetStride(data: DataView, dlOff: number, dlSize: number): number | null {
    if (dlSize < 4) return null;
    const prim = data.getUint8(dlOff);
    if (!(prim >= 0x80 && prim <= 0x9f)) return null; // must start with a GX draw

    const count = data.getUint16(dlOff + 1, false /* BE */);
    if (count === 0 || count > 0x4000) return null;

    const endMax = dlOff + dlSize;
    const samePrim: number[] = [];
    const draw: number[] = [];
    const other: number[] = [];

    for (let s = 2; s <= 24; s++) {
      const pos = dlOff + 3 + count * s;
      if (pos >= endMax) break;
      const b = data.getUint8(pos);
      if (b === prim) samePrim.push(s);
      else if (b >= 0x80 && b <= 0x9f) draw.push(s);
      else if (b === 0x61 || b === 0x08 || b === 0x10 || b === 0x20 || b === 0x40) other.push(s);
    }

    if (samePrim.length) return samePrim[0];
    if (draw.length)     return draw[0];
    if (other.length)    return other[0];
    return null;
  }

  function scanStrideCandidates(data: DataView, dlOff: number, dlSize: number): number[] {
    if (dlSize < 4) return [];
    const prim = data.getUint8(dlOff);
    if (!(prim >= 0x80 && prim <= 0x9f)) return [];

    const count = data.getUint16(dlOff + 1, false /* BE */);
    if (count === 0 || count > 0x4000) return [];

    const endMax = dlOff + dlSize;
    const samePrim: number[] = [];
    const draw: number[] = [];
    const other: number[] = [];

    for (let s = 2; s <= 24; s++) {
      const pos = dlOff + 3 + count * s;
      if (pos >= endMax) break;
      const b = data.getUint8(pos);
      if (b === prim) samePrim.push(s);
      else if (b >= 0x80 && b <= 0x9f) draw.push(s);
      else if (b === 0x61 || b === 0x08 || b === 0x10 || b === 0x20 || b === 0x40) other.push(s);
    }
    return [...samePrim, ...draw, ...other];
  }

  function forceVCDStrideTo(vcdIn: GX_VtxDesc[], targetStride: number): GX_VtxDesc[] {
    const v = vcdClone(vcdIn);
    let cur = vcdIndexBytes(v) + vcdDirectBytes(v);
    if (cur === targetStride) return v;

    if (cur < targetStride) {
      let need = targetStride - cur;

      // Ensure PNMTXIDX is DIRECT first (adds 1)
      if (need > 0 && v[GX.Attr.PNMTXIDX]?.type !== GX.AttrType.DIRECT) {
        v[GX.Attr.PNMTXIDX] = { type: GX.AttrType.DIRECT };
        need--;
      }
      // Then enable TEXnMTXIDX as DIRECT until we hit the target
      for (let i = 0; i < 8 && need > 0; i++) {
        const a = GX.Attr.TEX0MTXIDX + i;
        if ((v[a]?.type ?? GX.AttrType.NONE) !== GX.AttrType.DIRECT) {
          v[a] = { type: GX.AttrType.DIRECT };
          need--;
        }
      }
      return v;
    } else {
      let over = cur - targetStride;

      // Drop TEXnMTXIDX first
      for (let i = 7; i >= 0 && over > 0; i--) {
        const a = GX.Attr.TEX0MTXIDX + i;
        if (v[a]?.type === GX.AttrType.DIRECT) {
          v[a] = { type: GX.AttrType.NONE };
          over--;
        }
      }
      // Then drop PNMTXIDX if needed
      if (over > 0 && v[GX.Attr.PNMTXIDX]?.type === GX.AttrType.DIRECT) {
        v[GX.Attr.PNMTXIDX] = { type: GX.AttrType.NONE };
        over--;
      }
      return v;
    }
  }

  function tuneVCDForDL(
    data: DataView,
    dlOff: number,
    dlSize: number,
    baseVcd: GX_VtxDesc[],
    fields: any,
    shader: Shader
  ): GX_VtxDesc[] {
    if (!fields.oldVat || dlSize < 4) return baseVcd;

    const target = guessTargetStride(data, dlOff, dlSize);
    if (target == null) return baseVcd;

    const curStride = vcdIndexBytes(baseVcd) + vcdDirectBytes(baseVcd);
    if (curStride === target) return baseVcd;

    const forced = forceVCDStrideTo(baseVcd, target);
    const newStride = vcdIndexBytes(forced) + vcdDirectBytes(forced);
    if (newStride === target) {
     // console.warn(
      //  `[VCD_FORCE] @0x${dlOff.toString(16)} stride ${curStride} -> ${newStride} ` +
      //  `(PN=${forced[GX.Attr.PNMTXIDX]?.type === GX.AttrType.DIRECT ? 1 : 0}, ` +
      //  `TEXMTX=${(() => { let n=0; for(let i=0;i<8;i++) if (forced[GX.Attr.TEX0MTXIDX+i]?.type===GX.AttrType.DIRECT) n++; return n; })()})`
    //  );
      return forced;
    }
    return baseVcd;
  }
  // === END VCD/DL STRIDE FORCE ===

  const runBitstream = (
    modelShapes: ModelShapes,
    bitsOffset: number,
    drawStep: number,
    posBuffer: DataView,
    nrmBuffer?: DataView,
  ) => {
   // console.log(`running bitstream at offset 0x${bitsOffset.toString(16)}`);
   // console.warn(`[RUN_BITS] drawStep=${drawStep} offset=0x${bitsOffset.toString(16)}`);

    modelShapes.shapes[drawStep] = [];
    const shapes = modelShapes.shapes[drawStep];
    if (bitsOffset === 0) return;

    let curShader = shaders[0];
    let curMaterial: SFAMaterial | undefined = undefined;

    function dlHasAlphaCompare(dl: DataView): boolean {
      const bytes = new Uint8Array(dl.buffer, dl.byteOffset, dl.byteLength);
      for (let i = 0; i + 4 < bytes.length; i++) {
        // GX BP write opcode=0x61; next byte is BP register (Alpha Compare is 0xF3).
        if (bytes[i] === 0x61 && bytes[i + 1] === 0xF3) return true;
      }
      return false;
    }

    const setShader = (num: number) => {
      curShader = shaders[num];
      if (model.materials[num] === undefined) {
        if (fields.isMapBlock)
if (usingDummyClr) {
  const cloned = {
    ...curShader,
    attrFlags: curShader.attrFlags & ~ShaderAttrFlags.CLR,
  };
  model.materials[num] = materialFactory.buildMapMaterial(cloned, texFetcher);
} else {
  model.materials[num] = materialFactory.buildMapMaterial(curShader, texFetcher);
}
        else
          model.materials[num] = materialFactory.buildObjectMaterial(curShader, texFetcher, hasSkinning);
      }
      curMaterial = model.materials[num];
    };
    setShader(0);

    const bits = new LowBitReader(data, bitsOffset);
    let vcd: GX_VtxDesc[] = [];
    let done = false;

    while (!done) {
      const opcode = bits.get(4);
      switch (opcode) {
        case Opcode.SetShader: {
          const shaderNum = bits.get(6);
        //  console.log(`Setting shader #${shaderNum}`);
          setShader(shaderNum);
          break;
        }

        case Opcode.CallDL: {
          const listNum = bits.get(fields.numListBits);
         // console.warn(`[CALL_DL] list=${listNum}/${dlInfos.length} step=${drawStep} numListBits(field)=${fields.numListBits}`);
          if (listNum >= dlInfos.length) {
           // console.warn(`Can't draw display list #${listNum} (out of range)`);
            continue;
          }
          const dlInfo = dlInfos[listNum];
          if (!dlInfo || dlInfo.offset === 0 || dlInfo.size === 0 || (dlInfo.offset + dlInfo.size) > data.byteLength) {
          //  console.warn(`[DL_SKIP] list=${listNum} invalid dlInfo (offs=0x${dlInfo?.offset?.toString(16) ?? '??'} size=0x${dlInfo?.size?.toString(16) ?? '??'})`);
            break;
          }

          const displayList = dataSubarray(data, dlInfo.offset, dlInfo.size);
        //  console.warn(`[DL] #${listNum} offs=0x${dlInfo.offset.toString(16)} size=0x${dlInfo.size.toString(16)}`);

          // --- DL sniff logs (first 10 DLs only) ---
          if (listNum < 10) {
            try {
              const base = dlInfo.offset >>> 0;
              const prim = data.getUint8(base);
              const cnt = data.getUint16(base + 1, false /* BE */);
              if (prim >= 0x80 && prim <= 0x9f && cnt > 0) {
                const candidates: string[] = [];
                for (const s of [2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24]) {
                  const p2 = base + 3 + cnt * s;
                  if (p2 < data.byteLength) {
                    const b = data.getUint8(p2);
                    if (isLikelyGXOpcode(b)) candidates.push(`s=${s}->0x${b.toString(16)} @+0x${(p2-base).toString(16)}`);
                  }
                }
             //   console.warn(`[DL_STRIDE_GUESS] list=${listNum} prim=0x${prim.toString(16)} count=${cnt} candidates=[${candidates.join(', ')}]`);
              } else {
             //   console.warn(`[DL_STRIDE_GUESS] list=${listNum} prim=0x${prim.toString(16)} (not GX draw)`);
              }
            } catch (e) {
            //  console.warn(`[DL_STRIDE_GUESS] list=${listNum} error: ${e instanceof Error ? e.message : String(e)}`);
            }

            // Dump first 16 bytes
            {
              const base = dlInfo.offset >>> 0;
              const lim = Math.min(base + 16, data.byteLength);
              let s = '';
              for (let p = base; p < lim; p++) s += data.getUint8(p).toString(16).padStart(2, '0') + ' ';
            //  console.warn(`[DL_BYTES] list=${listNum} @0x${base.toString(16)} : ${s.trim()}`);
            }

            // Find first plausible GX opcode within +0x40
            {
              const base = dlInfo.offset >>> 0;
              const maxFwd = Math.min(0x40, Math.max(0, data.byteLength - base));
              let firstGX = -1;
              for (let d = 0; d < maxFwd; d++) {
                const b = data.getUint8(base + d);
                if (isLikelyGXOpcode(b)) { firstGX = base + d; break; }
              }
             // console.warn(`[DL_SNIFF] list=${listNum} firstGX=${firstGX >= 0 ? '0x' + firstGX.toString(16) : 'none'} delta=${firstGX >= 0 ? '0x' + (firstGX - base).toString(16) : 'n/a'}`);
              if (firstGX >= 0) {
                const lim2 = Math.min(firstGX + 16, data.byteLength);
                let s2 = '';
                for (let p = firstGX; p < lim2; p++) s2 += data.getUint8(p).toString(16).padStart(2, '0') + ' ';
              //  console.warn(`[DL_BYTES+] list=${listNum} @0x${firstGX.toString(16)} : ${s2.trim()}`);
              }
            }
          }
          // --- end DL sniff logs ---

          if ((displayList.byteLength | 0) === 0) {
          //  console.warn('[GEOM] Empty display list -> nothing to render');
          }

          // Early1/Early3: detect BP alpha-compare and OR it into the shader if necessary.
          if ((fields.shaderFields as any).isEarly1 || (fields.shaderFields as any).isEarly3) {
            if (!(curShader.flags & ShaderFlags.AlphaCompare) && dlHasAlphaCompare(displayList)) {
              curShader.flags |= ShaderFlags.AlphaCompare;
            }
          }

          const hasSpecial = dlInfo.specialBitAddress !== undefined && dlInfo.specialBitAddress !== 0;
          const shaderSaysWater = !!(curShader.flags & ShaderFlags.Water);
          const shaderSaysLava  = !!(curShader.flags & ShaderFlags.Lava);

          const isEarly1 = (version === ModelVersion.Early1) || !!fields.shaderFields?.isEarly1;
          const isEarly3 = (version === ModelVersion.Early3) || !!fields.shaderFields?.isEarly3;
          const isold    = (version === ModelVersion.Early1) || !!fields.shaderFields?.isold;

          let waterStreamIndex = -1;
          if (isEarly1 && bitsOffsets.length > 0) {
            waterStreamIndex = (bitsOffsets.length >= 3 && bitsOffsets[2] !== 0) ? 2 : (bitsOffsets.length - 1);
          } else if (isEarly3 && bitsOffsets.length > 0) {
            waterStreamIndex = bitsOffsets.length - 1;
          } else if (isold && bitsOffsets.length > 0) {
            waterStreamIndex = (bitsOffsets.length >= 3 && bitsOffsets[2] !== 0) ? 2 : (bitsOffsets.length - 1);
          }
          const isDedicatedWaterPass = !!fields.isMapBlock && waterStreamIndex >= 0 && drawStep === waterStreamIndex;

          const tryPushWaterFromSpecial = (): boolean => {
            if (!hasSpecial) return false;
            const ws = runSpecialBitstreamMulti(
              bitsOffset,
              dlInfo.specialBitAddress!,
              materialFactory.buildWaterMaterial.bind(materialFactory),
              posBuffer,
              nrmBuffer,
              vcd,
              (s) => !!(s.flags & ShaderFlags.Water) && !(s.flags & ShaderFlags.Lava)
            );
            if (ws.length > 0) {
              for (const s of ws) modelShapes.waters.push(s);
              return true;
            }
            return false;
          };

          // Sanity: warn if VCD asks for buffers that don't exist
          if (vcd[GX.Attr.CLR0]?.type !== GX.AttrType.NONE && clrCount === 0)
            console.error('[ATTR] CLR0 requested but clrCount==0');
          if (vcd[GX.Attr.NRM]?.type !== GX.AttrType.NONE && !fields.hasNormals)
            console.error('[ATTR] NRM requested but hasNormals==false');

          // ---- WATER path ----
          if (!shaderSaysLava && (shaderSaysWater || isDedicatedWaterPass)) {
            if (tryPushWaterFromSpecial()) break;

            const vtxArrays = getVtxArrays(posBuffer, nrmBuffer);
            const waterMat = materialFactory.buildWaterMaterial(curShader);
            const tunedVcd = tuneVCDForDL(data, dlInfo.offset, dlInfo.size, vcd, fields, curShader);

            const geom = new ShapeGeometry(vtxArrays, tunedVcd, vat, displayList, model.hasFineSkinning);
            geom.setPnMatrixMap(pnMatrixMap, hasSkinning, model.hasFineSkinning);
            if (dlInfo.aabb !== undefined) geom.setBoundingBox(dlInfo.aabb);
            if (dlInfo.sortLayer !== undefined) geom.setSortLayer(dlInfo.sortLayer);

            const shape = new Shape(geom, new ShapeMaterial(waterMat), false);
            modelShapes.waters.push(shape);
            break;
          }

          // ---- Normal geometry path ----
          const vtxArrays = getVtxArrays(posBuffer, nrmBuffer);

          // Early-3: DL enables alpha-compare? clone material once.
          let materialForDL = curMaterial!;
          if ((fields.shaderFields as any).isEarly3 &&
              !(curShader.flags & ShaderFlags.AlphaCompare) &&
              dlHasAlphaCompare(displayList)) {
            const cloned: Shader = { ...curShader, flags: curShader.flags | ShaderFlags.AlphaCompare };
            materialForDL = fields.isMapBlock
              ? materialFactory.buildMapMaterial(cloned, texFetcher)
              : materialFactory.buildObjectMaterial(cloned, texFetcher, fields.hasBones && jointCount >= 2);
          }

          const tunedVcd = tuneVCDForDL(data, dlInfo.offset, dlInfo.size, vcd, fields, curShader);

          // Guard tiny DLs (cnt*s beyond size)
          {
            try {
              const base = dlInfo.offset >>> 0;
              const prim = data.getUint8(base);
              const cnt = data.getUint16(base + 1, false);
              if (prim >= 0x80 && prim <= 0x9f && cnt > 0) {
                const b = (a: number) => tunedVcd[a]?.type === GX.AttrType.INDEX16 ? 2
                                    : tunedVcd[a]?.type === GX.AttrType.INDEX8  ? 1 : 0;
                let direct = 0;
                if (tunedVcd[GX.Attr.PNMTXIDX]?.type === GX.AttrType.DIRECT) direct++;
                for (let i = 0; i < 8; i++)
                  if (tunedVcd[GX.Attr.TEX0MTXIDX + i]?.type === GX.AttrType.DIRECT) direct++;

                const idxBytes = b(GX.Attr.POS) + b(GX.Attr.NRM) + b(GX.Attr.CLR0) + b(GX.Attr.TEX0) +
                                 b(GX.Attr.TEX1) + b(GX.Attr.TEX2) + b(GX.Attr.TEX3);
                const needed = 3 + cnt * (idxBytes + direct);
                if (needed > dlInfo.size) {
              //    console.warn(`[DL_TINY_SKIP] list=${listNum} cnt=${cnt} need=${needed} > size=${dlInfo.size}`);
                  break; // skip this DL only
                }
              }
            } catch { /* ignore sniff errors */ }
          }

          const attrTypeToStr = (t: GX.AttrType) =>
            t === GX.AttrType.NONE ? 'NONE' :
            t === GX.AttrType.DIRECT ? 'DIRECT' :
            t === GX.AttrType.INDEX8 ? 'INDEX8' :
            t === GX.AttrType.INDEX16 ? 'INDEX16' : `UNK(${t})`;

          const logGeomFail = (e: unknown, tag: string) => {
            const v = (a: GX.Attr) => tunedVcd[a]?.type ?? GX.AttrType.NONE;
            const typeStr = (t: GX.AttrType) =>
              t === GX.AttrType.NONE ? 'NONE' :
              t === GX.AttrType.DIRECT ? 'DIRECT' :
              t === GX.AttrType.INDEX8 ? 'INDEX8' :
              t === GX.AttrType.INDEX16 ? 'INDEX16' : `${t}`;

            const posStride = 6, nrmStride = (normalFlags & NormalFlags.NBT) ? 9 : 3, texStride = 4;
            const msg = (e as Error)?.message ?? String(e);

           // console.warn(
           //   `[GEOM_FAIL:${tag}] list=${listNum}/${dlInfos.length} step=${drawStep} ` +
           //   `offs=0x${dlInfo.offset.toString(16)} size=0x${dlInfo.size.toString(16)} ` +
           //   `VCD{POS=${typeStr(v(GX.Attr.POS))} NRM=${typeStr(v(GX.Attr.NRM))} CLR=${typeStr(v(GX.Attr.CLR0))} ` +
           //   `T0=${typeStr(v(GX.Attr.TEX0))} T1=${typeStr(v(GX.Attr.TEX1))} T2=${typeStr(v(GX.Attr.TEX2))} T3=${typeStr(v(GX.Attr.TEX3))} ` +
           //   `PN=${typeStr(v(GX.Attr.PNMTXIDX))} TMX#=${(() => { let n=0; for(let i=0;i<8;i++) if (tunedVcd[GX.Attr.TEX0MTXIDX+i]?.type===GX.AttrType.DIRECT) n++; return n; })()}} ` +
           //   `VAT5{POS.shift=${vat[5][GX.Attr.POS].compShift} NRM.compType=${vat[5][GX.Attr.NRM].compType}} ` +
           //   `POS{offs=0 len=${posBuffer.byteLength} stride=${posStride}} ` +
           //   `NRM{offs=0 len=${nrmBuffer?.byteLength ?? 0} stride=${nrmStride}} ` +
           //   `CLR{offs=0 len=${clrBufferForArrays.byteLength} stride=2} ` +
           //   `T0{offs=0 len=${texcoordBuffer.byteLength} stride=${texStride}} ` +
           //   `msg=${msg}`
           // );
          };

          try {
            const geom = new ShapeGeometry(vtxArrays, tunedVcd, vat, displayList, model.hasFineSkinning);
            geom.setPnMatrixMap(pnMatrixMap, hasSkinning, model.hasFineSkinning);
            if (dlInfo.aabb !== undefined) geom.setBoundingBox(dlInfo.aabb);
            if (dlInfo.sortLayer !== undefined) geom.setSortLayer(dlInfo.sortLayer);

            const shape = new Shape(
              geom,
              new ShapeMaterial(materialForDL),
              !!(curShader.flags & ShaderFlags.DevGeometry)
            );
            shapes.push(shape);
          } catch (err) {
            logGeomFail(err, 'PRIMARY');

            // Retry Z: alternative vertex strides for THIS DL only.
            {
              const altSeq = scanStrideCandidates(data, dlInfo.offset, dlInfo.size);
              let recovered = false;
              for (const s of altSeq) {
                const vcdAlt = forceVCDStrideTo(vcd, s);
                const curIdx = vcdIndexBytes(vcdAlt) + vcdDirectBytes(vcdAlt);
                if (curIdx !== s) continue;

                try {
                  const geomAlt = new ShapeGeometry(vtxArrays, vcdAlt, vat, displayList, model.hasFineSkinning);
                  geomAlt.setPnMatrixMap(pnMatrixMap, hasSkinning, model.hasFineSkinning);
                  if (dlInfo.aabb !== undefined) geomAlt.setBoundingBox(dlInfo.aabb);
                  if (dlInfo.sortLayer !== undefined) geomAlt.setSortLayer(dlInfo.sortLayer);

                  const shapeAlt = new Shape(
                    geomAlt,
                    new ShapeMaterial(materialForDL),
                    !!(curShader.flags & ShaderFlags.DevGeometry)
                  );
                  shapes.push(shapeAlt);
                 // console.warn(`[GEOM_RETRY_OK] list=${listNum} via alt stride=${s}`);
                  recovered = true;
                  break;
                } catch (errAlt) {
                  logGeomFail(errAlt, `RETRY+ALTSTRIDE(${s})`);
                }
              }
              if (recovered) break;
            }

            // Retry A: skip 0x20 preamble seen in some demo DLs
            if (dlInfo.size > 0x20) {
              try {
                const displayList2 = dataSubarray(data, dlInfo.offset + 0x20, dlInfo.size - 0x20);
                const geom2 = new ShapeGeometry(vtxArrays, tunedVcd, vat, displayList2, model.hasFineSkinning);
                geom2.setPnMatrixMap(pnMatrixMap, hasSkinning, model.hasFineSkinning);
                if (dlInfo.aabb !== undefined) geom2.setBoundingBox(dlInfo.aabb);
                if (dlInfo.sortLayer !== undefined) geom2.setSortLayer(dlInfo.sortLayer);

                const shape2 = new Shape(
                  geom2,
                  new ShapeMaterial(materialForDL),
                  !!(curShader.flags & ShaderFlags.DevGeometry)
                );
                shapes.push(shape2);
               // console.warn(`[GEOM_RETRY_OK] list=${listNum} (skipped 0x20-byte DL header)`);
                break;
              } catch (err2) {
                logGeomFail(err2, 'RETRY+SKIP20');
              }
            }

            // Retry B: drop PNMTXIDX as last resort
            if (tunedVcd[GX.Attr.PNMTXIDX]?.type === GX.AttrType.DIRECT) {
              const vcdRetry = tunedVcd.slice();
              vcdRetry[GX.Attr.PNMTXIDX] = { type: GX.AttrType.NONE };
              try {
                const geom = new ShapeGeometry(vtxArrays, vcdRetry, vat, displayList, model.hasFineSkinning);
                geom.setPnMatrixMap(pnMatrixMap, /*hasSkinning*/ false, model.hasFineSkinning);
                if (dlInfo.aabb !== undefined) geom.setBoundingBox(dlInfo.aabb);
                if (dlInfo.sortLayer !== undefined) geom.setSortLayer(dlInfo.sortLayer);

                const shape = new Shape(
                  geom,
                  new ShapeMaterial(materialForDL),
                  !!(curShader.flags & ShaderFlags.DevGeometry)
                );
                shapes.push(shape);
              //  console.warn(`[GEOM_RETRY_OK] list=${listNum} (PNMTXIDX disabled)`);
                break;
              } catch (err3) {
                logGeomFail(err3, 'RETRY');
              }

              // Retry C: PNMTXIDX disabled + skip 0x20
              if (dlInfo.size > 0x20) {
                try {
                  const displayList3 = dataSubarray(data, dlInfo.offset + 0x20, dlInfo.size - 0x20);
                  const geom3 = new ShapeGeometry(vtxArrays, vcdRetry, vat, displayList3, model.hasFineSkinning);
                  geom3.setPnMatrixMap(pnMatrixMap, /*hasSkinning*/ false, model.hasFineSkinning);
                  if (dlInfo.aabb !== undefined) geom3.setBoundingBox(dlInfo.aabb);
                  if (dlInfo.sortLayer !== undefined) geom3.setSortLayer(dlInfo.sortLayer);

                  const shape3 = new Shape(
                    geom3,
                    new ShapeMaterial(materialForDL),
                    !!(curShader.flags & ShaderFlags.DevGeometry)
                  );
                  shapes.push(shape3);
                 // console.warn(`[GEOM_RETRY_OK] list=${listNum} (PNMTXIDX disabled + skip 0x20)`);
                  break;
                } catch (err4) {
                  logGeomFail(err4, 'RETRY+PNOFF+SKIP20');
                }
              }
            }
          }

          // ---- FUR path ----
          if (drawStep === 0 &&
              (curShader.flags & (ShaderFlags.ShortFur | ShaderFlags.MediumFur | ShaderFlags.LongFur)) &&
              (dlInfo.specialBitAddress !== undefined && dlInfo.specialBitAddress !== 0)) {
            const furShapes = runSpecialBitstreamMulti(
              bitsOffset,
              dlInfo.specialBitAddress!,
              materialFactory.buildFurMaterial.bind(materialFactory),
              posBuffer,
              nrmBuffer,
              vcd,
              (s) => !!(s.flags & (ShaderFlags.ShortFur | ShaderFlags.MediumFur | ShaderFlags.LongFur))
            );
            const firstFur = furShapes[0];
            if (firstFur) {
              const layers = (curShader.flags & ShaderFlags.LongFur) ? 16
                           : (curShader.flags & ShaderFlags.MediumFur) ? 8 : 4;
              modelShapes.furs.push({ shape: firstFur, numLayers: layers });
            }
          }

          break;
        }

        case Opcode.SetVCD: {
          vcd = readVertexDesc(bits, curShader);

          const attrTypeToStr = (t: GX.AttrType) =>
            t === GX.AttrType.NONE ? 'NONE' :
            t === GX.AttrType.DIRECT ? 'DIRECT' :
            t === GX.AttrType.INDEX8 ? 'INDEX8' :
            t === GX.AttrType.INDEX16 ? 'INDEX16' : `UNK(${t})`;

          const show = (a: number) => attrTypeToStr(vcd[a]?.type ?? GX.AttrType.NONE);
        //  console.warn(
         //   `[VCD] POS=${show(GX.Attr.POS)} NRM=${show(GX.Attr.NRM)} CLR=${show(GX.Attr.CLR0)} ` +
        //    `T0=${show(GX.Attr.TEX0)} T1=${show(GX.Attr.TEX1)} T2=${show(GX.Attr.TEX2)} T3=${show(GX.Attr.TEX3)}`
       //   );

          const b = (a: number) =>
            vcd[a]?.type === GX.AttrType.INDEX16 ? 2 :
            vcd[a]?.type === GX.AttrType.INDEX8  ? 1 : 0;
          const idxBytesExpected =
            b(GX.Attr.POS) + b(GX.Attr.NRM) + b(GX.Attr.CLR0) + b(GX.Attr.TEX0) + b(GX.Attr.TEX1) + b(GX.Attr.TEX2) + b(GX.Attr.TEX3);
        //  console.warn(`[VCD_EXPECT] idxBytesPerVertex=${idxBytesExpected}`);

          let directBytes = 0;
          if (vcd[GX.Attr.PNMTXIDX]?.type === GX.AttrType.DIRECT) directBytes += 1;
          for (let i = 0; i < 8; i++) {
            if (vcd[GX.Attr.TEX0MTXIDX + i]?.type === GX.AttrType.DIRECT) directBytes += 1;
          }
        //  console.warn(`[VCD_DIRECT] directBytesPerVertex=${directBytes}`);
          break;
        }

        case Opcode.SetMatrices: {
          // Ignored for maps; relevant only for objects
          const numBones = bits.get(4);
          if (numBones > 10) throw Error('Too many PN matrices');
          for (let i = 0; i < numBones; i++)
            pnMatrixMap[i] = bits.get(8);
          break;
        }

        case Opcode.End:
          done = true;
          break;

        default:
        //  console.warn(`Skipping unknown model bits opcode ${opcode}`);
          break;
      }
    }
  };

  model.createModelShapes = () => {
    let instancePosBuffer: DataView;
    let instanceNrmBuffer: DataView | undefined;

    if (model.hasFineSkinning) {
      instancePosBuffer = dataCopy(model.originalPosBuffer);
      instanceNrmBuffer = dataCopy(model.originalNrmBuffer);
    } else {
      instancePosBuffer = model.originalPosBuffer;
      instanceNrmBuffer = model.originalNrmBuffer;
    }

    const modelShapes = new ModelShapes(model, instancePosBuffer, instanceNrmBuffer);

    for (let i = 0; i < bitsOffsets.length; i++) {
      try {
        runBitstream(modelShapes, bitsOffsets[i], i, modelShapes.posBuffer, modelShapes.nrmBuffer);
      } catch (err) {
      //  console.error(
       //   `[RUN_BITS_CRASH] step=${i} bitsOffs=0x${bitsOffsets[i].toString(16)} ` +
       //   `posLen=${modelShapes.posBuffer.byteLength} nrmLen=${modelShapes.nrmBuffer?.byteLength ?? 0} ` +
      //    `msg=${(err as Error)?.message}`
      //  );
        console.error(err);
        
      }
    }

    return modelShapes;
  };

  if (!model.hasFineSkinning)
    model.sharedModelShapes = model.createModelShapes();

  if (model.sharedModelShapes) {
    const countStep = (arr?: Shape[]) => (arr ? arr.length : 0);
   console.warn(
      `[RESULT] opaque0=${countStep(model.sharedModelShapes.shapes[0])} ` +
     `pass1=${countStep(model.sharedModelShapes.shapes[1])} ` +
      `pass2=${countStep(model.sharedModelShapes.shapes[2])} ` +
      `waters=${model.sharedModelShapes.waters.length} ` +
      `furs=${model.sharedModelShapes.furs.length}`
    );
  }

  return model; 
}
