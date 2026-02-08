import { hexzero } from '../util.js';
import ArrayBufferSlice from '../ArrayBufferSlice.js';
import * as GX_Texture from '../gx/gx_texture.js';
import { loadTextureFromMipChain, translateWrapModeGfx, translateTexFilterGfx } from '../gx/gx_render.js';
import { GfxDevice, GfxMipFilterMode, GfxTexture, GfxSampler, GfxFormat, makeTextureDescriptor2D, GfxWrapMode, GfxTexFilterMode } from '../gfx/platform/GfxPlatform.js';
import { DataFetcher } from '../DataFetcher.js';
import * as UI from '../ui.js';
import { ModelVersion } from "./modelloader.js";
import { GameInfo } from './scenes.js';
import { loadRes } from './resource.js';
import { readUint32 } from './util.js';
import * as Viewer from '../viewer.js';
import { TextureMapping } from '../TextureHolder.js';
import { GfxRenderCache } from '../gfx/render/GfxRenderCache.js';
// Options for PNG overrides (tiling & filtering)
type OverrideOpts = {
  wrap?: GfxWrapMode;
  minFilter?: GfxTexFilterMode;
  magFilter?: GfxTexFilterMode;
  mipFilter?: GfxMipFilterMode;
};

export class SFATexture {
    public viewerTexture?: Viewer.Texture;

    constructor(public gfxTexture: GfxTexture, public gfxSampler: GfxSampler, public width: number, public height: number) {
    }

    public static create(cache: GfxRenderCache, width: number, height: number) {
        const device = cache.device;
        const gfxTexture = device.createTexture(makeTextureDescriptor2D(GfxFormat.U8_RGBA_NORM, width, height, 1));
        const gfxSampler = cache.createSampler({
            wrapS: GfxWrapMode.Clamp,
            wrapT: GfxWrapMode.Clamp,
            minFilter: GfxTexFilterMode.Bilinear,
            magFilter: GfxTexFilterMode.Bilinear,
            mipFilter: GfxMipFilterMode.Nearest,
            minLOD: 0,
            maxLOD: 100,
        });

        return new SFATexture(gfxTexture, gfxSampler, width, height);
    }

    public destroy(device: GfxDevice) {
        device.destroyTexture(this.gfxTexture);
    }

    public setOnTextureMapping(mapping: TextureMapping) {
        mapping.reset();
        mapping.gfxTexture = this.gfxTexture;
        mapping.gfxSampler = this.gfxSampler;
        mapping.width = this.width;
        mapping.height = this.height;
        mapping.lodBias = 0.0;
    }
}

export class SFATextureArray {
    constructor(public textures: SFATexture[]) {
    }

    public destroy(device: GfxDevice) {
        for (let texture of this.textures) {
            texture.destroy(device);
        }
    }
}

export abstract class TextureFetcher {
    public abstract loadSubdirs(subdirs: string[], dataFetcher: DataFetcher): Promise<void>;
    public abstract getTextureArray(cache: GfxRenderCache, num: number, alwaysUseTex1: boolean): SFATextureArray | null;
    public getTexture(cache: GfxRenderCache, num: number, alwaysUseTex1: boolean) : SFATexture | null {
        const texArray = this.getTextureArray(cache, num, alwaysUseTex1);
        if (texArray) {
            return texArray.textures[0];
        } else {
            return null;
        }
    }
    public abstract destroy(device: GfxDevice): void;
}

function loadTexture(cache: GfxRenderCache, texData: ArrayBufferSlice, isBeta: boolean): SFATexture {
    const dv = texData.createDataView();
    const textureInput = {
        name: `Texture`,
        width: dv.getUint16(0x0A),
        height: dv.getUint16(0x0C),
        format: dv.getUint8(0x16),
        mipCount: dv.getUint16(0x1c) + 1,
        data: texData.slice(isBeta ? 0x20 : 0x60),
    };
    const fields = {
        wrapS: dv.getUint8(0x17),
        wrapT: dv.getUint8(0x18),
        minFilt: dv.getUint8(0x19),
        magFilt: dv.getUint8(0x1A),
    };
    
    const mipChain = GX_Texture.calcMipChain(textureInput, textureInput.mipCount);
    const loadedTexture = loadTextureFromMipChain(cache.device, mipChain);
    
    // GL texture is bound by loadTextureFromMipChain.
    const [minFilter, mipFilter] = translateTexFilterGfx(fields.minFilt);
    const gfxSampler = cache.createSampler({
        wrapS: translateWrapModeGfx(fields.wrapS),
        wrapT: translateWrapModeGfx(fields.wrapT),
        minFilter: minFilter,
        magFilter: translateTexFilterGfx(fields.magFilt)[0],
        mipFilter: mipFilter,
        minLOD: 0,
        maxLOD: 100,
    });

    const texture = new SFATexture(
        loadedTexture.gfxTexture,
        gfxSampler,
        textureInput.width,
        textureInput.height,
    );
    texture.viewerTexture = loadedTexture.viewerTexture;

    return texture;
}

function isValidTextureTabValue(tabValue: number) {
    return tabValue != 0xFFFFFFFF && (tabValue & 0x80000000) != 0;
}

function loadFirstValidTexture(cache: GfxRenderCache, tab: DataView, bin: ArrayBufferSlice, isBeta: boolean): SFATextureArray | null {
    let firstValidId = 0;
    let found = false;
    for (let i = 0; i < tab.byteLength; i += 4) {
        const tabValue = tab.getUint32(i);
        if (tabValue == 0xFFFFFFFF) {
            console.log(`no valid id found`);
            break;
        }
        if (isValidTextureTabValue(tabValue)) {
            found = true;
            break;
        }
        ++firstValidId;
    }
    if (!found) {
        return null;
    }

    return loadTextureArrayFromTable(cache, tab, bin, firstValidId, isBeta);
}

function loadTextureArrayFromTable(cache: GfxRenderCache, tab: DataView, bin: ArrayBufferSlice, id: number, isBeta: boolean): (SFATextureArray | null) {
    const tabValue = readUint32(tab, 0, id);
    if (isValidTextureTabValue(tabValue)) {
        const arrayLength = (tabValue >> 24) & 0x3f;
        const binOffs = (tabValue & 0xffffff) * 2;
        if (arrayLength === 1) {
            const compData = bin.slice(binOffs);
            const uncompData = loadRes(compData);
                console.log(`[TEXTURE INDEX] ID: ${id}, Index: 0, Offset: ${binOffs}, Size: ${uncompData.byteLength}`);

            return new SFATextureArray([loadTexture(cache, uncompData, isBeta)]);
        } else {
            const result = [];
            const binDv = bin.createDataView();
            for (let i = 0; i < arrayLength; i++) {
                const texOffs = readUint32(binDv, binOffs, i);
                const compData = bin.slice(binOffs + texOffs);
                const uncompData = loadRes(compData);
                    console.log(`[TEXTURE INDEX] ID: ${id}, Index: ${i}, Offset: ${texOffs}, Size: ${uncompData.byteLength}`);

                result.push(loadTexture(cache, uncompData, isBeta));
                
            }
            return new SFATextureArray(result);
        }
        } else {
  console.warn(`Texture id 0x${id.toString(16)} (tab value 0x${hexzero(tabValue, 8)}) not found in table.`);
  return null; // strict: do not auto-pick anything
}

  
}

function makeFakeTexture(cache: GfxRenderCache, num: number): SFATextureArray {
    const DIM = 128;
    const CHECKER = 32;

    const device = cache.device;
    const gfxTexture = device.createTexture(makeTextureDescriptor2D(GfxFormat.U8_RGBA_NORM, DIM, DIM, 1));
    const gfxSampler = cache.createSampler({
        wrapS: GfxWrapMode.Repeat,
        wrapT: GfxWrapMode.Repeat,
        minFilter: GfxTexFilterMode.Bilinear,
        magFilter: GfxTexFilterMode.Bilinear,
        mipFilter: GfxMipFilterMode.Nearest,
        minLOD: 0,
        maxLOD: 100,
    });

    // Thanks, StackOverflow.
    // let seed = num;
    // console.log(`Creating fake texture from seed ${seed}`);
    // function random() {
    //     let x = Math.sin(seed++) * 10000;
    //     return x - Math.floor(x);
    // }

    const baseColor = [255, 255, 255];
    //const baseColor = [127 + random() * 127, 127 + random() * 127, 127 + random() * 127];
    const darkBase = [baseColor[0] * 0.9, baseColor[1] * 0.9, baseColor[2] * 0.9];
    const light = [baseColor[0], baseColor[1], baseColor[2], 0xff];
    const dark = [darkBase[0], darkBase[1], darkBase[2], 0xff];

    // Draw checkerboard
    const pixels = new Uint8Array(DIM * DIM * 4);
    for (let y = 0; y < DIM; y++) {
        for (let x = 0; x < DIM; x++) {
            const cx = (x / CHECKER)|0;
            const cy = (y / CHECKER)|0;
            let color = !!(cx & 1);
            if (cy & 1)
                color = !color;
            const pixel = color ? light : dark;
            pixels.set(pixel, (y * DIM + x) * 4);
        }
    }

    device.uploadTextureData(gfxTexture, 0, [pixels]);

    return new SFATextureArray([new SFATexture(
        gfxTexture,
        gfxSampler,
        2,
        2,
    )]);
}

class TextureFile {
    private textures: (SFATextureArray | null)[] = [];
public listAllValidIds(): number[] {
    const ids: number[] = [];
    // Each entry in TAB is 4 bytes
    const count = (this.tab.byteLength / 4) | 0;
    for (let i = 0; i < count; i++) {
        const tabValue = this.tab.getUint32(i * 4);
        if (isValidTextureTabValue(tabValue)) ids.push(i);
    }
    return ids;
}

    constructor(private tab: DataView, private bin: ArrayBufferSlice, public name: string, private isBeta: boolean) {
    }

    public hasTexture(num: number): boolean {
        if (num < 0 || num * 4 >= this.tab.byteLength) {
            return false;
        }

        const tabValue = readUint32(this.tab, 0, num);
        return isValidTextureTabValue(tabValue);
    }

    public isTextureLoaded(num: number): boolean {
        return this.textures[num] !== undefined;
    }

    public getTextureArray(cache: GfxRenderCache, num: number): SFATextureArray | null {
        if (this.textures[num] === undefined) {
            try {
                const texture = loadTextureArrayFromTable(cache, this.tab, this.bin, num, this.isBeta);
                if (texture !== null) {
                    for (let arrayIdx = 0; arrayIdx < texture.textures.length; arrayIdx++) {
                        const viewerTexture = texture.textures[arrayIdx].viewerTexture;
                        if (viewerTexture !== undefined)
                            viewerTexture.name = `${this.name} #${num}`;
                            if (texture.textures.length > 1)
                                viewerTexture!.name += `.${arrayIdx}`;
                    }
                }
                this.textures[num] = texture;
            } catch (e) {
                console.warn(`Failed to load texture 0x${num.toString(16)} from ${this.name} due to exception:`);
                console.error(e);
                this.textures[num] = makeFakeTexture(cache, num);
            }
        }

        return this.textures[num];
    }

    public destroy(device: GfxDevice) {
        for (let texture of this.textures) {
            texture?.destroy(device);
        }
    }
}

async function fetchTextureFile(dataFetcher: DataFetcher, tabPath: string, binPath: string, isBeta: boolean): Promise<TextureFile | null> {
    try {
        const [tab, bin] = await Promise.all([
            dataFetcher.fetchData(tabPath),
            dataFetcher.fetchData(binPath),
        ])
        return new TextureFile(tab.createDataView(), bin, binPath, isBeta);
    } catch (e) {
        console.warn(`Failed to fetch texture file due to exception:`);
        console.error(e);
        return null;
    }
}

export class FakeTextureFetcher extends TextureFetcher {
  private textures: SFATextureArray[] = [];

  public getTextureArray(cache: GfxRenderCache, num: number, _alwaysUseTex1: boolean): SFATextureArray | null {
    if (this.textures[num] === undefined) this.textures[num] = makeFakeTexture(cache, num);
    return this.textures[num];
  }

  public async loadSubdirs(_subdirs: string[], _dataFetcher: DataFetcher): Promise<void> {
    // no-op
  }

  public destroy(device: GfxDevice) {
    for (const t of this.textures) t?.destroy(device);
    this.textures = [];
  }
}


class SubdirTextureFiles {
    constructor(public tex0: TextureFile | null, public tex1: TextureFile | null) {
    }

    public destroy(device: GfxDevice) {
        this.tex0?.destroy(device);
        this.tex0 = null;
        this.tex1?.destroy(device);
        this.tex1 = null;
    }
}
// Accept either an ArrayBufferLike or a Uint8Array and always copy to a fresh Uint8Array
async function decodePNGToRGBA(
  input: Uint8Array | ArrayBufferLike
): Promise<{ width: number; height: number; pixels: Uint8ClampedArray }> {
  const bytes = input instanceof Uint8Array
    ? input.slice() // copy -> guarantees non-SAB backing
    : new Uint8Array(input as ArrayBufferLike).slice();

  const blob = new Blob([bytes], { type: 'image/png' });
  const bmp = await createImageBitmap(blob);
  try {
    const w = bmp.width, h = bmp.height;
    let canvas: OffscreenCanvas | HTMLCanvasElement;
    let ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;

    if (typeof OffscreenCanvas !== 'undefined') {
      canvas = new OffscreenCanvas(w, h);
      ctx = canvas.getContext('2d');
    } else {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      canvas = c;
      ctx = c.getContext('2d');
    }
    if (!ctx) throw new Error('2D canvas context unavailable for PNG decode');

    (ctx as any).drawImage(bmp, 0, 0);
    const imgData = (ctx as any).getImageData(0, 0, w, h);
    return { width: w, height: h, pixels: imgData.data };
  } finally {
    bmp.close();
  }
}


function makeSampler(
  cache: GfxRenderCache,
  wrap: GfxWrapMode = GfxWrapMode.Clamp,
  minFilter: GfxTexFilterMode = GfxTexFilterMode.Bilinear,
  magFilter: GfxTexFilterMode = GfxTexFilterMode.Bilinear,
  mipFilter: GfxMipFilterMode = GfxMipFilterMode.Nearest,
): GfxSampler {
  return cache.createSampler({
    wrapS: wrap,
    wrapT: wrap,
    minFilter,
    magFilter,
    mipFilter,
    minLOD: 0,
    maxLOD: 100,
  });
}


async function createSFATextureFromPNG(
  cache: GfxRenderCache,
  pngBytes: Uint8Array | ArrayBufferLike,
  opts?: OverrideOpts
): Promise<SFATexture> {
  const device = cache.device;
  const { width, height, pixels } = await decodePNGToRGBA(pngBytes);

  const gfxTexture = device.createTexture(
    makeTextureDescriptor2D(GfxFormat.U8_RGBA_NORM, width, height, 1)
  );
  const view = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  device.uploadTextureData(gfxTexture, 0, [view]);

  const gfxSampler = makeSampler(
    cache,
    opts?.wrap ?? GfxWrapMode.Repeat,              // default to Repeat (prevents streaking)
    opts?.minFilter ?? GfxTexFilterMode.Bilinear,
    opts?.magFilter ?? GfxTexFilterMode.Bilinear,
    opts?.mipFilter ?? GfxMipFilterMode.Nearest,
  );
  return new SFATexture(gfxTexture, gfxSampler, width, height);
}


export class SFATextureFetcher extends TextureFetcher {
  /** List ALL raw texture IDs present in loaded TABs (TEX0/TEX1 and TEXPRE). */
public listAllTextureIDs(useTex1: boolean = false): number[] {
    const out = new Set<number>();

    // Subdir TEX0/TEX1 banks
    for (const subdir in this.subdirTextureFiles) {
        const files = this.subdirTextureFiles[subdir];
        const file = useTex1 ? files.tex1 : files.tex0;
        if (file) for (const id of file.listAllValidIds()) out.add(id);
    }

    // TEXPRE is only meaningful for TEX0 lookups via TEXTABLE, but we can expose it too.
    if (!useTex1 && this.texpre) {
        for (const id of this.texpre.listAllValidIds()) out.add(id);
    }

    return [...out].sort((a, b) => a - b);
}

/**
 * Force-load & register ALL textures from the tables so they appear in the UI list,
 * regardless of whether any material referenced them.
 * Returns counters for convenience.
 */
public loadAllFromTables(cache: GfxRenderCache, useTex1: boolean = false): { attempted: number; shown: number } {
    let attempted = 0, shown = 0;

    const registerArray = (arr: SFATextureArray | null, bankLabel: string, fileLabel: string, id: number) => {
        if (!arr) return;
        attempted++;
        for (let i = 0; i < arr.textures.length; i++) {
            const vt = arr.textures[i].viewerTexture;
            if (!vt) continue;

            // Give a stable / descriptive name if not set yet
            if (!vt.name || vt.name === 'Texture') {
                vt.name = `${bankLabel}:${fileLabel} #${id}${arr.textures.length > 1 ? `.${i}` : ''}`;
            }

            // Only push if not already in the holder (avoid duplicates)
            if (this.textureHolder.viewerTextures.indexOf(vt) === -1) {
                this.textureHolder.viewerTextures.push(vt);
                shown++;
            }
        }
    };

    // Walk all subdirs
    for (const subdir in this.subdirTextureFiles) {
        const files = this.subdirTextureFiles[subdir];
        const file = useTex1 ? files.tex1 : files.tex0;
        if (!file) continue;

        const ids = file.listAllValidIds();
        for (const id of ids) {
            // IMPORTANT: call TextureFile directly to bypass model-version remap logic.
            const arr = file.getTextureArray(cache, id);
            registerArray(arr, useTex1 ? 'TEX1' : 'TEX0', subdir || '(root)', id);
        }
    }

    // Include TEXPRE on the TEX0 side as well (optional but handy)
    if (!useTex1 && this.texpre) {
        const ids = this.texpre.listAllValidIds();
        for (const id of ids) {
            const arr = this.texpre.getTextureArray(cache, id);
            registerArray(arr, 'TEXPRE', '(global)', id);
        }
    }

    if (this.textureHolder.onnewtextures) this.textureHolder.onnewtextures();
    return { attempted, shown };
}

    private texturesEnabled = true;
public setTexturesEnabled(on: boolean) { this.texturesEnabled = on; }
public getTexturesEnabled() { return this.texturesEnabled; }

        private currentModelID: number = 0;
        public setCurrentModelID(id: number): void {
  this.currentModelID = id | 0;
  
}
// --- PATCH: allow opting specific Early1 models into "Copy of swaphol" preference ---
private preferCOSModelIDs = new Set<number>();
public preferCopyOfSwapholForModelIDs(ids: number[]) {
  for (const id of ids) this.preferCOSModelIDs.add(id | 0);
}
// --- END PATCH ---

private pngOverrides = new Map<number, { path: string, opts?: OverrideOpts }>();
private preloadedPngTextures = new Map<number, SFATextureArray>(); // texId -> ready texture
public setPngOverride(texId: number, relativePath: string, opts?: OverrideOpts): void {
  this.pngOverrides.set(texId, { path: relativePath, opts });

}

public async preloadPngOverrides(cache: GfxRenderCache, dataFetcher: DataFetcher): Promise<void> {
  const base = this.gameInfo.pathBase;
  for (const [texId, { path: rel, opts }] of this.pngOverrides) {
    if (this.preloadedPngTextures.has(texId)) continue;
    const buf  = await dataFetcher.fetchData(`${base}/${rel}`);
    const view = buf.createTypedArray(Uint8Array);
    const sfaTex = await createSFATextureFromPNG(cache, view, opts);
    this.preloadedPngTextures.set(texId, new SFATextureArray([sfaTex]));
   // console.log(`[PNG OVERRIDE] Preloaded texId ${texId} from ${base}/${rel}`);
  }
}

        

    loadAll() {
      throw new Error('Method not implemented.');
    }
    
    private textableBin: DataView;
    private texpre: TextureFile | null;
    private subdirTextureFiles: {[subdir: string]: SubdirTextureFiles} = {};
    private fakes: FakeTextureFetcher = new FakeTextureFetcher();
    private loadedTextureIDs: number[] = [];
private loadedTextures = new Map<number, { width: number, height: number, format: number }>();

    public textureHolder: UI.TextureListHolder = {
        viewerTextures: [],
        onnewtextures: null,
    };

private constructor(private gameInfo: GameInfo, private isBeta: boolean) {
    super();
    this.modelVersion = ModelVersion.Final; // default version
}
private modelVersion: ModelVersion;


    // This code assumes that a texture with a given ID is identical in all subdirectories
    // that contain a copy of it. If this is not the case, incorrect textures will appear.

    public static async create(gameInfo: GameInfo, dataFetcher: DataFetcher, isBeta: boolean): Promise<SFATextureFetcher> {
        const self = new SFATextureFetcher(gameInfo, isBeta);

        const pathBase = self.gameInfo.pathBase;
        const [textableBin, texpre] = await Promise.all([
            dataFetcher.fetchData(`${pathBase}/TEXTABLE.bin`),
            fetchTextureFile(dataFetcher,
                `${pathBase}/TEXPRE.tab`,
                `${pathBase}/TEXPRE.bin`, false), // TEXPRE is never beta
        ]);
        self.textableBin = textableBin!.createDataView();
        self.texpre = texpre;

        return self;
    }

    private async loadSubdir(subdir: string, dataFetcher: DataFetcher) {
        if (this.subdirTextureFiles[subdir] === undefined) {
            const pathBase = this.gameInfo.pathBase;
            const [tex0, tex1] = await Promise.all([
                fetchTextureFile(dataFetcher,
                    `${pathBase}/${subdir}/TEX0.tab`, 
                    `${pathBase}/${subdir}/TEX0.bin`, this.isBeta),
                fetchTextureFile(dataFetcher,
                    `${pathBase}/${subdir}/TEX1.tab`, 
                    `${pathBase}/${subdir}/TEX1.bin`, this.isBeta),
            ]);

            this.subdirTextureFiles[subdir] = new SubdirTextureFiles(tex0, tex1);

            // XXX: These maps need additional textures to be loaded
        
            if (subdir === 'clouddungeon' || subdir === 'cloudrace') {
                await this.loadSubdir('crfort', dataFetcher);
                 } else if (subdir === 'icemountain') {
                await this.loadSubdir('nwastes', dataFetcher);
            } else if (subdir === 'desert') {
                await this.loadSubdir('dfptop', dataFetcher);
                await this.loadSubdir('volcano', dataFetcher);
             } else  if (subdir === 'crfort') {
                await this.loadSubdir('gpshrine', dataFetcher);
            } else if (subdir === 'linkb' || subdir === 'linkf') {
                await this.loadSubdir('volcano', dataFetcher);
            } else if (subdir === 'shipbattle') {
                await this.loadSubdir('', dataFetcher);
         } else if (subdir === 'linkc') {
                await this.loadSubdir('nwastes', dataFetcher);
          } else if (subdir === 'mmpass') {
                await this.loadSubdir('shop', dataFetcher);
                await this.loadSubdir('warlock', dataFetcher);
                  } else if (subdir === 'swaphol') {
                 await this.loadSubdir('Copy of swaphol', dataFetcher);
                await this.loadSubdir('nwastes', dataFetcher);
                await this.loadSubdir('mmpass', dataFetcher);
            } else if (subdir === 'swapholbot' || subdir === 'shop') {
                await this.loadSubdir('Copy of swaphol', dataFetcher);
                await this.loadSubdir('swaphol', dataFetcher);
                 await this.loadSubdir('ecshrine', dataFetcher);
                 
            } else if (subdir === 'wallcity') {
                await this.loadSubdir('gpshrine', dataFetcher);
             } else if (subdir === 'darkicemines') {
          
                await this.loadSubdir('shop', dataFetcher);
           
             } else if (subdir === 'bossgaldon') {
                await this.loadSubdir('dragrock', dataFetcher);
             } else if (subdir === 'gpshrine') {
                await this.loadSubdir('dragrock', dataFetcher);
            } else if (subdir === 'mmshrine') {
                await this.loadSubdir('gpshrine', dataFetcher);
            }
                        } else if (subdir === 'nwastes') {
                await this.loadSubdir('icemountain', dataFetcher);
                            
        }
    }

    public async loadSubdirs(subdirs: string[], dataFetcher: DataFetcher) {
        const promises = [];
        for (let subdir of subdirs) {
            promises.push(this.loadSubdir(subdir, dataFetcher));
        }
        
        await Promise.all(promises);
    }
public setModelVersion(version: ModelVersion): void {
    this.modelVersion = version;
}

public logAllTex1TextureIDs() {
    for (const subdir in this.subdirTextureFiles) {
        const texFiles = this.subdirTextureFiles[subdir];
        if (texFiles.tex1) {
            console.log(`TEX1 textures in subdir "${subdir}":`);
            for (let i = 0; i < 5000; i++) {
                if (texFiles.tex1.hasTexture(i)) {
                    console.log(`  ID ${i}`);
                }
            }
        }
    }
}

public getTextureArray(cache: GfxRenderCache, texId: number, useTex1: boolean): SFATextureArray | null {
       console.log(`[TextureFetcher] Model ${this.currentModelID} requesting texture ID: ${texId}, useTex1: ${useTex1}`);
if (!this.texturesEnabled) {
  return this.fakes.getTextureArray(cache, texId, useTex1);
}

const early1TextureIdMap: Record<number, number> = {
        
  
5: 5555,
       24: 24, // Water is 24
  57: 60, // Correct
  58: 61, // Correct
  146: 980, //OFP //
  154: 980, //OFP not sure if correct
  157: 130, //OFP
  162: 146, //correct
 177: 157,
 176: 999, //correct
 268: 398,
427: 179, // CORRECT
 428: 186, //Nwastes rock pillars in cave 532?
 457: 563, //lava pit in shop correct
 
310: 256, //CORRECT
311: 257, //CORRCT
312: 253, //CORRECT
313: 258, //CORRECT
332: 483,
349: 486, //DR tuinnel floor correct
358: 1014, // 
361: 491, //DR tunnel top half correct
362: 491, // DR tunnel bottom half correct
 487: 483, //CORRECT
 488: 486, // CORRECT
  489: 485,
 490: 486,
  491: 487,
   492: 487,
493: 490,
  494: 491, // outside walls 491 correct?
  495: 492,
  496: 492,
  497: 5555,
  499: 501, //CORRECT
  500: 489, //CORRECT?
  502: 515,
503: 490,
  504: 486, // DR main circle central floor near tower
  505: 251, //DR main floor
   515: 486,
   547: 770, //CORRECT
   634: 1984,
639: 488,
898: 977, //CORRECT
901: 993, //CORRECT
912: 1005, //CORRECT

  417: 178, //CORRECT
  425: 181, //correct?
  // correct
 530: 522, // correct
 
 532: 592, // correct //MMP Karzoa bottom half 1353 592 593 594 1110
 533: 593, //(correct)
 534: 594, // correct
  536: 532, //Nwastes ice CORRECT
 
  
   541: 533, //Nwastes snow path 2 (correct?)
   542: 533,
   546: 534, //CORRECT
   549: 568,
 553: 1006, //1090? corect?
 555: 412, //CORRECT
  556: 532, //Nwastes tunnel cieling, correct?
  559: 532,
  560: 535, //CORRECT
  561: 559, //coorect
  562: 1123, //correct?
  563: 561, // correct
  564: 562, //correct
  565: 561, //correct
  566: 561, //spike in shop, should be floor? 564
  567: 564,
  568: 564, //correct
  569: 565, //correct
  570: 565, // correct?
  571: 566, //correct
  572: 567, //floor scarab in shop front half
  573: 567, //floor scarab in shop bottom half
  574: 565, 
  576: 534, //CORRECT
  638: 926, //Nwastes Tricky dig spot 926 but doesnt fit, cracks exist?
  640: 183, //CORRECT
  654: 654,
  657: 642, // correct

  674: 1012,
  675: 666, // (correct)
  691: 549, //1121? 1121 etc is cobwebs
  705: 674, //corct? 
  706: 565, //CORRECT
  707: 559, 
  708: 674, 
  709: 565,
  710: 654,
  711: 674,
  767: 766,
  856: 943, //correct
  860: 948, //Nwastes path sides CORRECT
   862: 949, //Nwastes statue rocks CORRECT
   871: 786, //Nwastes fence posts CORRECT 
  896: 980, //OFP 
   897: 991, //OFP //correct
    900: 975, //OFP //correct
    902: 1004, //CORRECT?
    903: 1005, //CORRECT?
    904: 1005,  //correct?
    905: 975,  //correct?
    906: 976, //correct?
  907: 977, //correct
  908: 978, //correct
   909: 977, //OFP walls //correct?
   910: 980, //correct
   913: 1007, //correct
   916: 1006, //correct? OFP floor
   917: 982, // OFP 982?
   918: 1009, // OFP 977?
   933: 951,
    943: 951,
    946: 1042, //Nwastes path to TTH TTH WELL ALSO USES THIS!
    947: 948, //Nwastes outsdie textures
      948: 942,
    949: 951,
     951: 537,
     952: 553, //CORRECT
     954: 951,
  974: 980, //OFP
  975: 974, //OFP 
  977: 980, //OFP
  978: 978, //OFP top of water pillars
  980: 1083, // correct
  981: 1084, //correct
  982: 1086, // ???
  983: 1085, //correct
  984: 1086, //correct
  985: 1087,
  986: 1087, //correct
  987: 1088, //correct, water odd though

  989: 1090, //correct
  990: 1091, //correct
  991: 1092, //correct
  992: 1090,
  993: 1090,
  994: 1096,  //correct
  995: 1097, //correct
  997: 1093, //correct
 1000: 1102, //correct
 1001: 1103, //correct
 1002: 1104, //correct
 1003: 1106, //correct
 1007: 1112, //correct
 1008: 1113, //correct
 1009: 1114, //correct
 1090: 979, //OFP
 1100: 398,
 2024: 2373, // red line under Test of sacrifice centre
 2141: 187, //CORRECT
 2206: 2205,
 2435: 2001,
 2635: 2222,
 

535: 897, 
651: 897, //CORRECT
660: 898, //CORRECT
719: 880,
720: 881, //CORRECT
 721: 879, //mmpass warppad right half
 722: 879, //mmpass warppad left half
807: 899, //CORRECT
 810: 908,
 812: 900,
813: 910, //Correct
 814: 909, //Mmpass floor CORRECT
 815: 910, //Mmpass Kaldachom circle nest CORRECT
 816: 530, //Mmpass walls CORRECT
 
 1812: 1761, //CORRECT
 1814: 406,
1815: 879, //correct???? metal ring around warppad
2094: 903, ///2199 as a backup

155: 977,
605: 398,
606: 301,
607: 323,
608: 398,
609: 398,
611: 398,
610: 398,
612: 592, //correct
613: 593, //correct
614: 594, //correct
615: 595, //correct
616: 398, //correc?
617: 1101, //correct
618: 398,
619: 398,
620: 1337,
621: 398,
622: 595, //1339 1294!
623: 398,
624: 1337,
666: 1337,
668: 1294,
899: 2373,//CORRECT? OFP water
976: 1346, //correct 1329
998: 1348, //correct?
1006: 1010, 
1010: 1115,//correct
1245: 1306, //correct
 1246: 1307, //correct?
 1252: 1314,
 1253: 1315, //correct
 1254: 1315,
 1255: 1317,
 1258: 1320, //correct
 1261: 1321, //correct
 1269: 1330, //correct
 1270: 1331, //correct
 1271: 1332, //correct
 1272: 1333, //correct
 1275: 1336, //correct
 1276: 1337, //correct?
 1277: 1338, //correct?
 1282: 1344, //correct
 1283: 1347,
 1287: 1349,
1288: 1353, //correct? 1357
 1289: 1345, //correct
 1307: 1337,
 
1345: 1337,


//CAPE CLAW
21: 64,
27: 44,
30: 45, //to do
31: 45,
32: 45,
33: 45,
34: 45,
36: 47,
37: 65,
45: 64,
46: 51, 
49: 45, // ???
59: 62,
61: 63,
62: 66,
67: 72,
68: 73, 
69: 62, //45/62/63
70: 1472, 
71: 74, 
//810: 722,
136: 61, //to do
811: 71,
914: 65,
915: 67,
1294: 35,
1295: 35,
2056: 54,
2640: 54,

//ICE MOUNTAIN
473: 957, //Nwasted path snow (unsure looks like ice instead of path material)
508: 722, //722?
509: 723, //correct
510: 724, //correct?
517: 725, //correct?
522: 724,
665: 726,
859: 726,
861: 726,
920: 726,

1101: 726,
1105: 5555,
1109: 1088,
1906: 726,
2139: 726,


//CRFortress + Dungeon
73: 402, //CORRECT
80: 85,
82: 84,
83: 85,
84: 86, //correct
85: 87,
86: 88,
87: 89,
88: 90,
89: 91,
90: 92,
91: 93,
92: 94,
93: 1038, //CORRECT
94: 97, //CORRECT
95: 98, //CORRECT
96: 99,
97: 100,
98: 1071, //CRF roof tops
99: 101, //CORRECT
100: 103,
101: 104,
103: 105, //CORRECT
414: 2761,
415: 396, //CORRECT
416: 396, //CORRECT
418: 397, //CORRECT //light?
419: 109, //CORRECT
422: 2761,
424: 415, //CORRECT
911: 978,
1491: 400, //CORRECT
1492: 2761,
2018: 2761,
2020: 2761,
2595: 2761,
2761: 93,

//CRF RACE
1466: 1528, //CORRECT
1467: 1529, //CORRECT
1468: 1530, //CORRECT
1469: 1531,
1470: 1532,
1471: 1533,
1472: 1533,
1473: 1535, //CORRECT
1474: 1536, //CORRECT
1475: 1537, //CORRECT
1524: 177, //CORRECT
1922: 406, //CORRECT
9: 405, //CORRECT

//VFPT

147: 5555,
577: 571, //CORRECT
579: 1170, //CORRECT
580: 574,
581: 5555,
582: 589, //???? could be 589?
583: 590, //??
584: 1163, //1934? 1163?
585: 1163, //1934? 1163?
586: 577, //CORRECT
587: 578, //CORRECT
588: 590, //CORRECT
589: 582, //CORRECT
590: 584, //CORRECT
591: 585, //CORRECT
592: 586, //CORRECT
593: 591, //CORRECT
595: 576, //CORRECT
596: 589, //CORRECT
597: 590, //CORRECT
598: 993, //?? 
599: 588, //587? 602 586 588
600: 580, //CORRECT
601: 579, //576 578 579
602: 575, //CORRECT
603: 5555, 
988: 570, //CORRECT 
999: 1100,

604: 571, //CORRECT

1035: 5555, 
1036: 5555, 
1051: 571,
1054: 503, //1159? 503 502 585 589
1057: 5555, 
1058: 5555, 
1061: 1163, //CORRECT
1062: 1163, //CORRECT
1063: 579, //576 578 579
1066: 1146, //588? 570 1146
1068: 572, //572? 502 502 602 1170 682 683 586
1073: 5555,
1074: 580, //CORRECT
1075: 5555,
1076: 5555,
1080: 5555,
1532: 5555,


//MAGIC CAVE
523: 523,
524: 522, //correct
525: 524, // light beams yellow, not sure if corrct?
526: 524,
527: 525, //CORRECT
528: 522, //525 is in circles karzao symobls
529: 526, // correct
531: 1649, // correct
539: 952, //Nwastes snow ground (correct?)

//TTH WELL
944: 543, //CORRECT


//ANIMTEST
199: 15,
200: 19,
391: 8,
392: 9,
757: 12,
550: 10,
554: 13,
717: 17,
809: 14,
968: 6,
1018: 7,
1019: 20,
2163: 16,

//Test of Sacrifice
//177: 5555,
//571: 5555,
//1005: 1083,
1013: 1083,
1014: 1084, //??
1016: 1085,
1017: 1086,
1020: 1089,
1021: 1090,
1026: 1096, //cental logo
1027: 1097, //central logo
1028: 1100,
1030: 1102,
1031: 1103,
1032: 1104,
1033: 1106,
1034: 1108,
1038: 1114,
1039: 1115, //??? incorrect
2090: 5555, //??
2727: 5555, //??

//Thorntail Hollow
//947: 5,
//948: 5,
//93: 5555, //CORRECT
384: 437, //439 Earthwalker tex
385: 438,
386: 439,
//532: 5555,
545: 614,
//547: 5555,
//549: 5555,
551: 620,
552: 621,
//553: 5555,
//556: 5555,
557: 627,
558: 628,
//559: 5555,
//568: 5555,
637: 713, //CORRECT
690: 765, //correct //760 wood trees? 713 tricky dig //629 underwater stones//918 invisible beam
//691: 5555,
718: 799,
723: 5555,
770: 5555,
//810: 5555,
//908: 5555,
942: 1026, //CORRECT
//946: 5555,
//952: 5555,
956: 1040, //CORRECT 1040
//1038: 5555,
1042: 5,


//Lightfoot Village
7: 755,  //????
543: 769, 
544: 779, //769 779
//547: 5555, 
763: 759, 
764: 760,
766: 765, 
//767: 5555, 
768: 755, //Foggy sky
769: 767, 
//770: 768, 
771: 770,
772: 771, 
773: 772, 
775: 777, 
776: 778, 
777: 1956, 
778: 779, 
779: 781,  
781: 782,
782: 784, //759
783: 784, 
784: 785, 
785: 787, 
787: 780, //>>>>  755 1955
//871: 5555, 
1156: 755, 
1811: 769, //870 761  769
//2640: 5555, 

//Test of Observation
1011: 5, // ?????
1005: 1108,
996: 1035,

//WALLED CITY

137: 1221, 
197: 1645,  //1645 2058 1948
387: 1094, 
388: 1247,
389: 5555, 
390: 1115,
//952: 1088,
1106: 1093,
1107: 1094,
1108: 1188, 
1110: 1088, 
1111: 1094, 
1112: 1180, 
1113: 1248, 
1114: 1197,
1115: 2358, 
1116: 1648, //2328 184 1648
1117: 1196,// CORRECT //1197? //1247 stone for others!
1118: 1197, 
1119: 1214, //1214 1648
1120: 1648, //1648 top op wooden spikes
1121: 1198, 
1122: 1188, 
1123: 1227, 
1124: 553, //t1866 1868 2358 1217 1218 ROCKY WALLS OR CAVES
1125: 1227,
1126: 1093,
1127: 1227,
1128: 1241, //1105 1241
1129: 1088, 
1130: 1088,
1131: 2358, //1868 1948 2358
1133: 1089, 
1134: 1089,
1135: 1211,  //1440 1211
1136: 1105,
1138: 1180, 
1139: 1198, 
1141: 1180,
1143: 1240, 
1145: 1082, 
1146: 1094, 
1147: 1213, // 2328 184
1148: 3500, // 1241 1121 1105
1149: 5555, 
1150: 1868, 
1151: 1220,
1152: 1090,
1153: 1206,
1154: 1091,
1155: 1091,
1161: 3501,
1157: 1092,
1158: 3611,
1159: 1093, 
1160: 3000, // 1094 1092 1191
1168: 1248, 
1187: 1096,
1188: 1094,
1189: 1095,
1190: 1248,
1191: 1095,
1192: 1221, 
1193: 1096,
1194: 5555,
1196: 5555,
1197: 5555,
1198: 5555,
1206: 5555,
1211: 5555,
1213: 5555,
1214: 5555,
1449: 5555, 
1489: 5555, 
1685: 5555,
1692: 1866, 
1695: 539, 
1696: 2358, 
1988: 1130, 
1989: 1130, 
1990: 1130, 
1991: 1130, 
2621: 1128, 
2624: 1115, 
2625: 1115, 



//BETA CLOUDRUNNER

//635,636,633,634
//633: 2761,
//634: 2762,
//635: 2763,
//636: 2764,

//up to 2760

//1644: 3058,
//1647: 3052,
//1649: 3054,

//3053,3054,3055,3056,3052

//DARKICE MINES
//5: 5555, //608 test
56: 59,
//57: 5555,
//58: 5555,
220: 5555,
221: 465,
437: 3612, //ladder
438: 206,
439: 468,
440: 3612,
442: 219,
443: 219,
449: 205,
450: 206,
451: 461,
454: 461,
455: 216,
//457: 5555,
458: 214,
461: 457,
462: 457,
463: 206,
465: 216, //456 471
466: 461,
468: 3613,
469: 222,
470: 221,
471: 220,
472: 233,
//473: 5555,
475: 466,
476: 467,
477: 219, //231 219
478: 224, //226 224
480: 197,
484: 197,
485: 238,
486: 206,
//638: 5555,
703: 219,
704: 206,
//723: 5555,
2047: 5555,
//2640: 5555,

};
const early2TextureIdMap: Record<number, number> = {

//Dragon Rock Bottom Early 2
303: 5555,
340: 497,
341: 497,
342: 497,
349: 5555,
353: 5555,
354: 5555,
357: 5555,
358: 5555,
361: 5555,
362: 5555,
370: 5555,
374: 483,
375: 483,
379: 5503,
380: 5503,
382: 5503,
446: 482,
514: 495, //DRB walkway and some walls// 243? 250? 282? 481? 494 looks likely 495
//520: 500, //499 correct?
497: 55555,
903: 5503,
976: 5503,
2068: 5502,
2069: 5503,
2718: 760, //lava CORRECT 497
2849: 5555,
2866: 499,
2867: 500, //correct?
2868: 498,
2869: 505,
2870: 241, // LAVA SEND THIS TO CORRECT BLOCK// ALSO 241 is blue circles walls near tansporter
2871: 494,
2872: 496,
2873: 505,
2874: 479,
2876: 482,
2877: 506, //506? 507?
2880: 506,
2879: 481,
3228: 5503,

//DRAGON ROCK
323: 256, //1801
325: 256,
326: 258,
371: 256,
//443: 486,
503: 483,
505: 484,
506: 487,
507: 487,
508: 490,
509: 490,
510: 491,
511: 492,
512: 492,
//514: 5555,
516: 256,
517: 489,
520: 490,
//573: 491,
648: 487,
653: 488,
2717: 5555, //??
2864: 486,
2865: 485,
3202: 253,
3364: 251,
3365: 256, //??inside bottom DR 255? 252?
3366: 252,
3367: 257,
3368: 5555, //??
3369: 251,
3370: 255, //255 2173
3371: 255,
3372: 257,
3373: 257,
3374: 490,
3375: 258,
3376: 487, //252 487 2173


//CLOUDRUNNER FORTRESS
5: 5555,
71: 76,
78: 85,
80: 84,
81: 85,
82: 86,
83: 87,
84: 88,
85: 89,
86: 90,
87: 91,
88: 92,
89: 93,
91: 95,
92: 97,
93: 98,
94: 99,
95: 100,
96: 1071, //originally 102
97: 101,
98: 103,
99: 104,
101: 105,
103: 107,
104: 108,
432: 109,
440: 113,
441: 411,
443: 415,
573: 412,
756: 5555, //???????
1542: 1552,
1543: 1553,
1544: 1513,
1996: 90,
2078: 96,
2080: 99,
2110: 1513, ////???? square panel
2465: 398, //1513 398
2674: 413,
//2718: 5555,
2723: 5555, //cobwebs

//BOSS TREX
793: 1138,
795: 1139,
1057: 1131,
1058: 1133,
1059: 1134,
1060: 1135,
1061: 1136,
1062: 1137,
1064: 1140,
1086: 1132,
//2718: 5555,

//VOLCANO FORCE POINT
595: 574, //1111 test
596: 575, //????
599: 1163,
603: 583, //correct
604: 582,
605: 584,
606: 585,
607: 586,
608: 587,
610: 589,
611: 590,
612: 591,
618: 682,
1094: 1934,
1095: 1934,
1108: 5555,
1109: 5555,
2826: 578,
2827: 579,
2828: 580,
2829: 576,
2830: 577,
2831: 591,
2832: 682, //683?
2833: 683,
2834: 685,
2835: 575,
2836: 575,
2967: 573,
2968: 581,
2969: 581,
2970: 581,
3218: 1170,
3219: 1170,
3221: 1146,
3225: 570,
3226: 588,
3227: 5555,
3388: 1171,
3389: 1111,

//Cloudrunner Dungeon
//86: 5555, //1525 test
90: 5555,
//92: 5555,
//97: 5555,
412: 5555,
415: 5555,
433: 396,
434: 396,
436: 397,
437: 398,
//443: 5555,
//573: 5555,
};
const earlydupTextureIdMap: Record<number, number> = {


//TEST OF STRENGTH
176: 1099, //??
553: 1090, //??
984: 1086, //??
988: 1089, //??
989: 1090, //??
994: 1096, //??
995: 1097, //??
1009: 1114, //??
2640: 1096, //??


//TEST OF KNOWLEDGE
87: 1068, //??
88: 1069,
90: 5555, //??
93: 1070,
96: 1071,
117: 1072, //??
177: 1073,
447: 1072,
503: 483, //2219 483 491
507: 258,
508: 490,
512: 257,
571: 1075,
650: 257,
783: 1076, //1083
785: 1077,
790: 1078,
791: 1079,
792: 1080,
793: 1081,
794: 1082,
795: 1083,
846: 1084,
847: 1085,
848: 1086,
1011: 1103,
1013: 1098,
1014: 1099,
1016: 1105,
1017: 1101,
1021: 1105,
1024: 1109, //should be 1109
1025: 1110,
1028: 1115,
1030: 1117, //changed
1031: 1118,
1032: 1119,
1033: 1121,
1034: 1123,
1037: 1128, //???
1039: 1130, //1130
1163: 1088,
1168: 1089,
1185: 1090,
1188: 1091,
1190: 1092,
1192: 1093,
1221: 1094,
1224: 1095,
1226: 1096,
2727: 5555,

//TEST OF FEAR
//177: 5555,
980: 1083,
981: 1084,
982: 1099, ////reflection on floor change this
983: 1085,
985: 1086, //??
986: 1087, //ceiling symbols incorrect
990: 1091,
991: 1092, //1105 bricks 1101, possible floors in corridor? OR 1099 an 1098
998: 1100,
1000: 1102,
1001: 1103,
1002: 1104,
1003: 1106,
1005: 1108,
1007: 1112,
1010: 1115, // metal on main disc incorrect
2460: 5555, //??

//COPY OF SWAPHOL
40: 40,
118: 118,
437: 437,
438: 438,
439: 439,
614: 614,
616: 616,
617: 617,
618: 618,
620: 620,
621: 621,
626: 626,
627: 627,
628: 628,
629: 629,
713: 713,
765: 765,
766: 766,
799: 799,
908: 908,
918: 918,
1026: 1026,
//1030: 5555,
//1031: 5555,
//1032: 5555,
1036: 1036,
1040: 1040,
2760: 2760,

};
const fearMapTextureIdMap: Record<number, number> = {

//EARLY 2001 TEST OF FEAR
189: 1099,
1065: 1083,
1066: 1084,
1067: 1085,
1068: 1086,
1069: 1087, //correct
1070: 1090,
1071: 1091,
1072: 1092,
1075: 1100,
1076: 1102,
1077: 1103,
1078: 1104,
1079: 1106,
1080: 1108,
1082: 1112,
1084: 1115,
2900: 1112,


};
const ancientMapTextureIdMap: Record<number, number> = {
//ANCIENT TTH //do Crfotr ancinet. . . . . . . . . . . . . . . . . . . . . . . . . . . . . .
2282: 5555,
44: 558,
430: 1680, //to do 2057 1680 //palm trees
431: 2060, //to do
432: 2060, //2060? 2057
565: 1978,
567: 2121,
568: 2365,
569: 2365, //correct
570: 537, //some main walls
571: 1042, //correct 542, 1042
572: 542, //GRASS or 1038?
573: 539,
575: 541, //541? trees
576: 539, 
577: 539,
578: 542, //correct 542, 1042 //GRASS
579: 548, //sandy section in egg cave
580: 553, //?? 1038 - could be used ofr centre montain 553, 554 1042
581: 552, //centre mountain bottom half
582: 553, //???? could be 589?
583: 553, 
584: 1042, //1934? 1163?
585: 1042, //1934? 1163?
586: 553,
680: 548, //548, 1042?
707: 548, 
708: 555, 
790: 548,
791: 1073, //light beams 760
917: 1041,
918: 544,
920: 1042,
921: 1041,
924: 537, //to do
927: 537, //to do
928: 1701, //flowers
930: 542, //1934? 1163?
933: 951,
2794: 2373, //water
2881: 545,
2882: 546, //mountain backdrop

//CRF
0: 130,
7: 97,
43: 97,
79: 97,
87: 85,
90: 103,
91: 84,
92: 85,
93: 86,
94: 87,
95: 88,
96: 90,
97: 91,
98: 92,
99: 93,
100: 95,
101: 97,
102: 99, // ???
105: 97,
106: 98,
107: 99, //1573 111
108: 1071,
109: 103,
111: 111, //???
112: 111, //??? 1573?
113: 111,
114: 104,
115: 104,
116: 107,
117: 108,
151: 109,
255: 5555, //???
456: 89,
457: 5555, //????
458: 98,
459: 103, //???
460: 2080, //2080 98
740: 130, //413 1817 1393 130
1352: 412, //??
1383: 98,
1389: 104, //104 105
1392: 24, //water
1402: 412,
1415: 1564, //1978
1416: 5555, //???
1926: 99, //??
1943: 98, //??
1988: 5555,
1989: 1161, //1113 1162
1990: 1162,


//SHOP
587: 559,
588: 561,
589: 560,
590: 562,
591: 561, // ????
592: 564,
593: 564,
594: 564, //??
595: 567,
596: 567,
597: 565,
598: 3002, //wood beams
687: 565,
688: 565,
689: 568,
690: 559,
691: 561, //561 1042 542 548 ????????????
692: 562,
693: 565,
694: 561,
695: 674,
696: 561,
697: 674,
698: 565,
699: 3001,
700: 3003,
701: 3004, //561 1042 674
702: 3005,
703: 3006,
704: 565,
705: 565,
706: 674, 
956: 559,
957: 565, //??
958: 562, //565 562
959: 562,
960: 674,
998: 563,

//Snowhorn Wastes
//255: 5555,
213: 210, //1803 1772 210
298: 948, //??
558: 2353,
564: 952, //553 SNOW
574: 531, //531 933 2248 (some trees)
599: 948,
600: 948, //?????
601: 948,
603: 532, //1803 209 1772 532
604: 949, //943 948 949
681: 1803, //1646 1645 1803
683: 2353, //  2030 2353 ??????????????
684: 531, //942 531
800: 957,
811: 957, ///snow cliffs
813: 5555, //??
818: 5555,// ??
836: 957, //957 937 //paths
840: 919, //943 919 957 937 //rocky walls
851: 919, 
856: 532,
1198: 5555, //????
1317: 572, //1159 572 1170
1347: 2122, //????
1662: 2122, //?????
1797: 948,
1798: 1803,
1799: 948, //???????
1805: 130,
1806: 130,
1927: 130,
1928: 130,
1935: 50,
1951: 950,
1952: 950,
2046: 917, //1803 130 (portal beams)
2216: 948, //2122 948 949 943 (Mountain and snowy walls?)
2225: 775, //775 944 (firepit cold sharpclaw)
2228: 2248, //2248 933 (some trees)
2231: 2353, //1589 2353 (bottom half of some trees)
2465: 2122, //????????
2467: 2248, //some trees 933 2248
2538: 2248, //some more trees
2541: 919,
2747: 533, //533 532 952 957
2791: 1802, //1802 969


//ICE MOUNTAIN: TO DO-
554: 5555, //???
555: 5555,
556: 5555,
559: 5555,
561: 5555,
605: 5555,
670: 5555,
677: 5555,
678: 5555,
709: 5555,
710: 580,
711: 5555,
712: 584,
857: 5555,
858: 5555,
1649: 5555,
1729: 5555,
1831: 5555,
1832: 5555,
1833: 5555,
1834: 5555,
1835: 5555,
1836: 5555,
1837: 5555,
1838: 5555,
2166: 5555,
2748: 5555,


//CRF RACE
3: 405,
//255: 5555,
103: 1537,
104: 1537,
118: 402,
120: 1537,
320: 1537,
845: 404, //??
1365: 1528, //CORRECT
1366: 1529, //CORRECT
1367: 1531,
1368: 1533,
1369: 1537, //??
1370: 1534, //??
1371: 1535,
1372: 1536,
1373: 551,
1374: 407,
1375: 1537, //??
1376: 407, //??
1391: 24, //WATER
1727: 402,
1730: 403,
1728: 1761, //1761 400 502 261
1839: 406,
2390: 1537, //??
2862: 404,
2863: 1532,
2870: 401,
2883: 402,


//Krazoa Palace
//255: 5555,
606: 596,
607: 595,
608: 591,
609: 613, 
610: 590, 
611: 558, 
612: 611, 
613: 616, //50 301 1683 1338 1329 1348 1349
614: 617, //301 1303 1344
615: 617,
616: 610, 
617: 609, 
618: 612, //1905  //Krazoa head giant 51
619: 608, 
620: 606, 
621: 607, 
622: 605, 
623: 592, 
624: 593, 
625: 594, 
626: 5555, //?? 
627: 563, //??
628: 604, 
629: 615, //transport walls
630: 603, 
631: 589, 
632: 588, 
633: 579, 
634: 602, 
635: 618, //walls
636: 587, 
637: 4100,
638: 586, 
639: 614,
640: 5555, //??
641: 583,
642: 582, //top krazoa and underneath
643: 581,
644: 602,
645: 611,
646: 601, 
647: 600, 
648: 5555, //??
649: 599, 
651: 5555, //??
671: 598, 
672: 1294, 
//696: 5555,
//709: 599,
//710: 599,
//711: 599,
//712: 5555, 
713: 760, //WATER 1294
714: 5555,
1146: 585, 
1175: 597, 
1176: 602, 
2793: 760, //??


//WILLOW GROVE
794: 2003,
795: 2002,
796: 2001,
797: 2000,
931: 5555,
1084: 2037,
1085: 2036,
1086: 2035,
1087: 2034,
1088: 2033,
1089: 2032,
1090: 2031,
1091: 2030,
1092: 2029,
1093: 2028,
1094: 2027,
1095: 2026,
1097: 2025,
1098: 2024,
1099: 2023,
1100: 2022,
1101: 2021,
1102: 2020,
1103: 2019,
1104: 2018,
1106: 2017,
1107: 2016,
1109: 2015,
1110: 2014,
1111: 2013,
1112: 2012,
1113: 2011,
1115: 2010,
1116: 2009,
1117: 2008,
1118: 2007,
1119: 2006,
1120: 2005,

//1347: 5555,
//1927: 5555,
//1928: 5555,
1936: 2004,
//1951: 5555,
//1952: 5555,
1953: 5555,
1954: 5555,
1955: 5555,
2784: 5555,

//DRAGON ROCK
231: 5555,
340: 5555,
341: 5555,
342: 5555,
343: 5555,
344: 5555,
348: 5555,
349: 5555,
351: 5555,
350: 5555,
352: 5555,
371: 5555,
389: 5555,
398: 5555,
401: 5555,
403: 5555,
404: 5555,
410: 5555,
412: 5555,
414: 5555,
415: 5555,
416: 5555,
418: 5555,
2798: 5555,

};

const dftpmap: Record<number, number> = {
173: 4013, 
185: 4012,
186: 4011,
189: 999,   
198: 4010,
203: 4001,
2954: 4000,
2960: 4001,
3050: 4002,
3051: 4003,
3052: 4004,
3053: 4005,
3054: 4001, //floor bit
3055: 4006,
3056: 4007,
3057: 4008,
3058: 4009,
};

const early3TextureIdMap: Record<number, number> = {
//SHOP
651: 537,
656: 542,
660: 544,
668: 552,
670: 553,
674: 556,
675: 557, //puggy centre
677: 559,
678: 560,
679: 561,
680: 562,
681: 562, //??
682: 563, //lava
683: 564,
684: 565,
685: 567,
686: 568,
688: 5555, //shop sign1
689: 5555, //shop sign 2
690: 5555, //shop sign 3
691: 5555, //shop sign 4
692: 5555,
693: 569,
803: 674,


//TEST OF OBSERVATION
1183: 1083,
1184: 1084,
1185: 1085,
1186: 1086,
1188: 1088,
1189: 1093,
1191: 1090,
1200: 1108,
1202: 1035, //light beam
1203: 1100,
1205: 1102,
1206: 1103,
1207: 1104,
1208: 1090,
1210: 1108,
1211: 1110,
1214: 1113,
1216: 1115,
1219: 5555,
2795: 1105,

//SNOWHORN WASTES
1011: 1602, //1956
1012: 951,
1013: 917,
1014: 919,
1021: 926,
1022: 943,
1032: 5555, //?? edged bleeding into mountain background
1033: 937, //532 937
1037: 5555, //??
1038: 949, // 943 949
1039: 942,
1040: 943,
1041: 944,
1044: 947,
1045: 948,
1047: 949,
1048: 950,
1051: 952,
1056: 957,
1058: 960,
1062: 964,
1067: 968, //????
1068: 969,

//MAGIC CAVE
629: 522,
630: 5555, //524 525 526 528
631: 524,
632: 524,
633: 525,
634: 526,
635: 5555,
636: 526,

// KRAZOA PALACE
723: 592, //1582 lava test
724: 593,
725: 594,
726: 595,
727: 1330,
1449: 1331,
1450: 1303,
1451: 1330,
1453: 1306,
1454: 1307,
1455: 1307,
1457: 1330, //1330 1337 1304
1458: 1309,
1463: 1314,
1464: 1315,
1466: 5555, //??
1468: 1319,
1469: 1321,
1470: 1294,
1477: 1330,
1478: 1331,
1480: 1333,
1484: 1337,
1485: 1338,
1486: 1337,
1492: 1345,
1493: 1346,
1494: 1347,
1495: 1348,
1496: 1349, //transporter beam top
1500: 1353,
1501: 1330,
1506: 5555, //??

//THORNTAIL HOLLOW
647: 552, //1021
648: 917,
//651: 5555,
652: 538,
653: 539,
655: 541,
657: 542,
//658: 5555, //??
//660: 5555,
661: 545,
662: 546,
664: 548,
665: 549,
//668: 5555,
669: 553,
671: 554,
672: 908,
673: 555,
//674: 5555,
//675: 5555,
676: 558,
1131: 1038,
1135: 1042,

//TTH WELL
649: 534,
650: 535,
//656: 5555,
658: 543,
659: 1042,
//665: 5555,
//670: 5555,
//673: 5555,
//675: 5555,


//ICE MOUNTAIN
627: 519, //2004 test
843: 720,
844: 716,
845: 717,
846: 718, //CORRECT
847: 719,
848: 722,
849: 723,
850: 724,
851: 721,
852: 721,
853: 728, //transporter centreal beam
854: 725,
855: 726,
856: 727,
857: 728,

//DARKICE MINES

227: 205, //608 test
228: 206,
247: 213,
248: 214,
257: 216,
258: 217,
261: 219,
262: 220,
263: 221,
264: 222,
265: 224,
266: 225,
279: 233,
280: 234,
281: 235,
296: 238,
565: 455,
566: 456,
567: 457,
568: 458,
570: 460,
571: 461,
573: 463,
574: 464,
575: 465,
576: 468,
579: 467,
580: 466,
581: 198,
582: 5555,
1395: 199,
1396: 200,

//LINKB ICE2WASTES

916: 789,
917: 791,
918: 792,
919: 793,
920: 794,

//LINKA - WARPSTONE TO OTHERS
963:873,

//LINK C WASTES 2 HOLLOW
921: 797, //130, 796 797
922: 917,
923: 798,
924: 797,
925: 5555,

//LINK C WASTES 2 HOLLOW
926: 801, //801 802 803 804
927: 802,
928: 804,

//BOSS GALDON
509: 178,
523: 179,
527: 181,
528: 179,
532: 186,
738: 1984, //metal rims
741: 180,
742: 183,
768: 182,
1753: 5555,
1752: 177,
2334: 187,

//GREAT FOX
617: 508, //508 509 686 687 689 690 691 692 694 695 697 699 700 703 704 705 706 707 708
618: 509,
815: 686,
816: 687, //?? upside down portraits
817: 689,
818: 690,
819: 691,
820: 692,
821: 693,
822: 695,
823: 696,
824: 699,
825: 700,
828: 703,
829: 704,
830: 671,
831: 706,
832: 509,
833: 707,
834: 708,
//835: 705,

//DARKICE MINES 2

534: 445, //1429 test
535: 430,
536: 1429,
537: 432, //arrow walls //432
538: 432, //??
539: 432, //??
540: 193,
541: 449,
542: 433,
543: 444,
544: 433,
545: 434,
546: 435, //CORRECT
547: 436,
548: 437,
549: 439,
550: 440,
551: 441,
552: 441,
553: 442, //CORRECT
554: 446,
555: 444,
556: 447,
557: 448,
558: 450,
559: 435,
560: 451,
561: 455,
562: 453,
563: 454,
564: 455,

};

const early4TextureIdMap: Record<number, number> = {
//SHOP
651: 537,
656: 542,
660: 544,
668: 552,
670: 553,
674: 556,
675: 557, //puggy centre
677: 559,
678: 560,
679: 561,
680: 562,
681: 562, //??
682: 563, //lava
683: 564,
684: 565,
685: 567,
686: 568,
688: 5555, //shop sign1
689: 5555, //shop sign 2
690: 5555, //shop sign 3
691: 5555, //shop sign 4
692: 5555,
693: 569,
803: 674,
2881: 566, //TO DO

//TEST OF OBSERVATION
1183: 1083,
1184: 1084,
1185: 1085,
1186: 1086,
1188: 1088,
1189: 1093,
1191: 1090,
1200: 1108,
1202: 1035, //light beam
1203: 1100,
1205: 1102,
1206: 1103,
1207: 1104,
1208: 1090,
1210: 1108,
1211: 1110,
1214: 1113,
1216: 1115,
1219: 5555,
2795: 1105,

//SNOWHORN WASTES
929: 951,
930: 917,
931: 919,
937: 943,
938: 926,
939: 943,
942: 5555,
943: 5555,
944: 5555,
947: 5555,
948: 943, //??
949: 5555,
950: 937,
951: 5555,
952: 5555,
954: 5555,
955: 949,
956: 942,
957: 943,
958: 944,
960: 947, //???
961: 947,
962: 948,
964: 949,
965: 950,
966: 950,
967: 952,
972: 957,
975: 960,
979: 964,
983: 968,
984: 968,
985: 969,
2486: 531,

//MAGIC CAVE
629: 522,
630: 5555, //524 525 526 528
631: 524,
632: 524,
633: 525,
634: 526,
635: 5555,
636: 526,

//KRAZOA PALACE
646: 592, //1582 lava test
647: 593,
648: 594,
649: 595,
650: 1330,
//1335: 1337,
1336: 1303,
1339: 1306,
1340: 1307,
1352: 5555, //??
1354: 1320,
1355: 1321,
1356: 1294,
1364: 1330,
1365: 1331,
1371: 1337,
1373: 1337,
1379: 1345,
1380: 1346,
1381: 1347,
1383: 1349, //transpoter top
1388: 1330,
1393: 5555, //??
2497: 1338,
2498: 1315,
2499: 1333,
2500: 2298, //1294 top fog 760 1301 130 1339 2360 2297 2298
2501: 1348,
2502: 1314, //correct
2503: 1330,
2504: 1309,
2505: 1353,

//THORNTAIL HOLLOW
572: 917,
575: 537,
576: 538,
577: 539,
579: 541,
581: 542,
582: 543,
583: 544,
584: 545,
585: 546,
587: 548,
588: 549,
591: 552,
592: 553,
594: 554,
595: 908, //light beam?
596: 555,
597: 556,
598: 557,
599: 558,
1054: 1038,
1058: 1042,

//TTH WELL
//649: 5555,
//650: 5555,
658: 543,
665: 549,
669: 553,
673: 555,
//675: 5555,
1131: 1038,
1135: 1042,

//ICE MOUNTAIN
551: 519,
764: 720,
765: 716,
766: 717,
767: 718,
768: 719,
769: 722,
770: 723,
771: 724,
772: 721,
773: 721,
774: 728,
775: 725,
776: 726,
777: 727,
778: 728,

//DARKICE MINES
214: 205,
215: 206,
222: 213,
223: 214,
225: 216,
226: 217,
227: 219,
228: 220,
229: 221,
230: 222,
231: 224,
232: 225,
239: 233,
240: 234,
241: 235,
243: 238,
489: 456,
490: 457,
491: 458,
493: 460,
494: 461,
496: 463,
497: 465,
498: 466,
499: 467,
500: 468,
504: 198,
505: 5555,
2574: 199,
2575: 200,
2576: 5555,

//LINKB ICE2WASTES
836: 789,
837: 791,
838: 792,
839: 793,
840: 794,
2572: 790,

//LINKA - WARPSTONE TO OTHERS
963:873,

//LINK C WASTES 2 HOLLOW
841: 797, //130, 796 797
842: 917,
843: 798,
844: 797,
845: 797,
846: 5555,


//LINK D DIM to DIM2
926: 801, //801 802 803 804
927: 802,
928: 804,

//BOSS GALDON
2871: 1984,
2885: 179,
2886: 183,
2887: 186,
2888: 187,
2889: 182,
2890: 180,
2891: 178,
2892: 181,
2893: 177,
2894: 5555,

//TITLE SCREEN
541: 508,
542: 509,
736: 686,
737: 687,
738: 689,
739: 690,
740: 691,
741: 692,
742: 693,
743: 695,
744: 696,
745: 699,
746: 700,
749: 703,
750: 704,
751: 2013, //671 2013
752: 706,
753: 509,
754: 707,
755: 708,
756: 5555,

//DARKICE MINES 2

535: 430,
536: 1429,
537: 432, //arrow walls //432
538: 432, //??
539: 432, //??
540: 193,
544: 433,
545: 434,
546: 435, //CORRECT
547: 436,
548: 437,
549: 439,
550: 440,
//551: 441,
552: 441,
553: 442, //CORRECT
554: 446,
555: 444,
556: 447,
557: 448,
558: 450,
560: 451,
561: 455,
562: 453,
563: 454,
564: 455,
2800: 436,
2801: 433,
2802: 1429, //??
2873: 445,
2884: 444,

//DRAGON ROCK (to do)
253: 5555,
254: 5555,
256: 5555,
258: 5555,
259: 5555,
260: 5555,
510: 5555,
512: 5555,
514: 5555,
515: 5555,
517: 5555,
518: 5555,
519: 5555,
2507: 5555,
2508: 5555,
2509: 5555,
2510: 5555,
2511: 5555,
2512: 5555,
2513: 5555,
2514: 5555,
2515: 5555,
2516: 5555,

//CLOUDRUNNER FORTRESS 
80: 76,
88: 84,
89: 85,
90: 86,
91: 87,
92: 88,
93: 89,
94: 90,
95: 91,
96: 92,
97: 93,
99: 95, //CORRECT
100: 96, //????
101: 97,
102: 98,
103: 99,
104: 100, //?????
105: 102, //CORRECT
106: 101,
107: 103,
109: 105,
111: 107,
112: 108,
113: 109,
//512: 5555,
513: 410,
516: 411,
//518: 5555,
//519: 5555,
520: 414,
521: 415,
1716: 1552,
1717: 1553,

//LIGHTFOOT VILLAGE
884: 768,
885: 757,
886: 757,
887: 759,
888: 760,
889: 761,
890: 762,
891: 764,
892: 765,
893: 766,
894: 755,
895: 767,
897: 769,
898: 770,
899: 772,
900: 773,
901: 774,
903: 777,
904: 778,
905: 779,
906: 780,
907: 755,
908: 781,
909: 782,
910: 783,
911: 784,
912: 785,
913: 786,
914: 787,
915: 788,

//WALLED CITY
1301: 1187, //2341 test
1302: 1187, //1241 1187 1242
1305: 1242,
1306: 1188,
1308: 1191,
1309: 1192,
1310: 1191,
1311: 1192, //1241
1312: 1194,
1313: 1193,
1314: 1194,
1315: 1228,
1322: 5555, //??
1330: 1236,
1332: 1211,
1333: 1241,
1335: 3610,
1338: 1209,
1341: 1216,
1342: 1217,
1343: 1218,
1344: 1215,
1345: 1221,
1346: 1198,
1349: 1226,
1350: 1227,
//1352: 5555,
1353: 1197,
//1354: 5555,
//1355: 5555,
//1356: 5555,
1357: 1236,
1358: 1239,
1359: 1240,
1360: 1241,
1361: 1243,
1362: 1244,
1370: 1246,
1390: 5555,
1391: 1248,
1395: 1249,
1396: 1249,
1397: 2341, //??
2825: 1219,
2826: 1219,
2833: 1213,
2834: 1214,
2835: 1215,
2836: 3612,
2837: 3613,
2838: 3614,
2839: 1223,
2840: 1224,
2841: 1225,
2842: 1201,

//BOSS TREX
1153: 1131, //2340 test
1154: 1132,
1155: 1133,
1156: 1134,
1157: 1135,
1158: 1136,
1159: 1137,
1160: 1138,
1161: 1139,
1163: 1140,
1164: 1141,

};
// --- per-map overrides for Early4 ---
// KEY = mapNum you pass when constructing Early4MapSceneDesc
// VALUE = { originalTexId: remappedTexId } FIRST NUMBER e.g 11 for KP is map number

const EARLY1_PER_MODEL_REMAP: { [mapNum: number]: { [srcId: number]: number } } = {
 // Cloud Treasure
  15: { 100: 100, 114: 114, 124: 124,489: 489, 630: 630, 1619: 1619, 1620: 1620, 1621: 1621,
    1954: 1954, 2175: 2175, 2176: 2176, 2574: 2574, 2849: 2849,},

      // Link Level
  64: { 91: 91, 565: 565, 705: 705, 736: 736,},
   
        // Insdie Galleon
  30: { 57: 61, 58: 62, 86: 85, 87: 86, 93: 92, 666: 657, 530: 522, 533: 525, 532: 524,
     531: 523, 528: 520, 675: 666, 529: 521, 523: 515, 524: 516, },

           // Thorntail Hollow
  7: {  559: 629,  568: 5, 556: 626, 553: 621, 549: 618, 547: 616, 532: 450, 946: 1030, 952: 1036,
    
  },
  
   
};
const EARLY4_PER_MODEL_REMAP: { [mapNum: number]: { [srcId: number]: number } } = {
  // Krazoa Palace
  11: { 649: 595, 650: 1330, 1335: 1337, },

  // TTH Well
  8: { 649: 534, 650: 535 },

    // Title screen Palace
  63: { 541: 508,542: 509, },

    // Darkice Mines 2
  27: { 551: 441 },

      // Ice Mountain
  23: {541: 519, },

        // Cloudrunner Fortress
  12: {518: 412, 519: 413, },

        // Dragon Rock
  2: {518: 491, 443: 486, 573: 491,},

       // Walled city
  13: {1352:3611, 1354:1230, 1355: 1229, 1356:1232, },

         // Boss Trex
  48: {2718:5555, },


};
const EARLYDUP_PER_MODEL_REMAP: { [mapNum: number]: { [srcId: number]: number } } = {
           // Thorntail Hollow
  7: {1030:1030, 1031:1031, 1032:1032 },
};
if (this.modelVersion === ModelVersion.Early1) {
  const per = EARLY1_PER_MODEL_REMAP[this.currentModelID];
  if (per && per[texId] !== undefined) {
    texId = per[texId];
  } else if (early1TextureIdMap[texId] !== undefined) {
    texId = early1TextureIdMap[texId];
  } else {
    return this.fakes.getTextureArray(cache, texId, useTex1);
  }

 
} else if (this.modelVersion === ModelVersion.AncientMap) {
    if (!(texId in ancientMapTextureIdMap)) return this.fakes.getTextureArray(cache, texId, useTex1)
    texId = ancientMapTextureIdMap[texId];
    
} else if (this.modelVersion === ModelVersion.dup) {
  const per = EARLYDUP_PER_MODEL_REMAP[this.currentModelID];
  if (per && per[texId] !== undefined) {
    texId = per[texId];
  } else if (earlydupTextureIdMap[texId] !== undefined) {
    texId = earlydupTextureIdMap[texId];
  } else {
    return this.fakes.getTextureArray(cache, texId, useTex1);
  }
   
} else if (this.modelVersion === ModelVersion.fear) {
    if (!(texId in fearMapTextureIdMap)) return this.fakes.getTextureArray(cache, texId, useTex1);
    texId = fearMapTextureIdMap[texId];

} else if (this.modelVersion === ModelVersion.dfpt) {
  if (!(texId in dftpmap)) return this.fakes.getTextureArray(cache, texId, useTex1);
  texId = dftpmap[texId];

  } else if (this.modelVersion === ModelVersion.Early2) {
  if (!(texId in early2TextureIdMap)) return this.fakes.getTextureArray(cache, texId, useTex1);
  texId = early2TextureIdMap[texId];

} else if (this.modelVersion === ModelVersion.Early4) {
  const per = EARLY4_PER_MODEL_REMAP[this.currentModelID];
  if (per && per[texId] !== undefined) {
    texId = per[texId];
  } else if (early4TextureIdMap[texId] !== undefined) {
    texId = early4TextureIdMap[texId];
  } else {
    return this.fakes.getTextureArray(cache, texId, useTex1);
  }


  } else if (this.modelVersion === ModelVersion.Early3) {
  if (!(texId in early3TextureIdMap)) return this.fakes.getTextureArray(cache, texId, useTex1);
  texId = early3TextureIdMap[texId];
  }


  
// PNG override check (after ID remaps)
const pngHit = this.preloadedPngTextures.get(texId);
if (pngHit) {
   // console.log(`[TextureFetcher] Using PNG override for texId ${texId}`);
    return pngHit;
}
    let file = this.getTextureFile(texId, useTex1);

if (file.file === null) {
    console.warn(`Texture ID ${texId} was not found in any loaded subdirectories (${Object.keys(this.subdirTextureFiles)})`);
   return this.fakes.getTextureArray(cache, texId, useTex1);
 // Show checker instead of guessing
}


    const isNewlyLoaded = !file.file.isTextureLoaded(file.texNum);
    const textureArray = file.file.getTextureArray(cache, file.texNum);
    if (textureArray === null) {
    return this.fakes.getTextureArray(cache, texId, useTex1);

}

    if (isNewlyLoaded && textureArray !== null) {
        for (let arrayIdx = 0; arrayIdx < textureArray.textures.length; arrayIdx++) {
            const viewerTexture = textureArray.textures[arrayIdx].viewerTexture;
            if (viewerTexture !== undefined) {
                this.textureHolder.viewerTextures.push(viewerTexture);
                if (this.textureHolder.onnewtextures !== null)
                    this.textureHolder.onnewtextures();
            }
        }
    }

    return textureArray;
}


private getTextureFile(texId: number, useTex1: boolean): { texNum: number, file: TextureFile | null } {
  let texNum = texId;

  // TEXTABLE / TEXPRE mapping (unchanged)
  if (!useTex1) {
    const textableValue = this.textableBin.getUint16(texId * 2);
    if (texId < 3000 || textableValue === 0) {
      texNum = textableValue;
    } else {
      texNum = textableValue + 1;
      return { texNum, file: this.texpre };
    }
  }

// Prefer "Copy of swaphol" for dup / Demo globally,
// and for *specific* Early1 model IDs we opt in.
const preferCOS =
  this.modelVersion === ModelVersion.dup ||
  this.modelVersion === ModelVersion.Demo ||
  (this.modelVersion === ModelVersion.Early1 && this.preferCOSModelIDs.has(this.currentModelID));

  const tryCOS = (): TextureFile | null => {
    const cos = this.subdirTextureFiles['Copy of swaphol'];
    const file = useTex1 ? cos?.tex1 : cos?.tex0;
    return (file && file.hasTexture(texNum)) ? file : null;
  };

  // 1) For Demo / dup, prefer Copy of swaphol first
  if (preferCOS) {
    const cosHit = tryCOS();
    if (cosHit) return { texNum, file: cosHit };
  }

  // 2) Primary search: every other loaded subdir EXCEPT Copy of swaphol
  for (const subdir in this.subdirTextureFiles) {
    if (subdir === 'Copy of swaphol') continue;
    const files = this.subdirTextureFiles[subdir];
    const file = useTex1 ? files.tex1 : files.tex0;
    if (file && file.hasTexture(texNum)) return { texNum, file };
  }

  // 3) Final fallback: try Copy of swaphol even for other versions
  // (lets models that actually live there still find their textures,
  // but since we didn’t prefer it, it won’t hijack Final models)
  if (!preferCOS) {
    const cosHit = tryCOS();
    if (cosHit) return { texNum, file: cosHit };
  }

  return { texNum, file: null };
}



    public destroy(device: GfxDevice) {
        this.texpre?.destroy(device);
        for (let subdir in this.subdirTextureFiles) {
            this.subdirTextureFiles[subdir].destroy(device);
        }
        this.subdirTextureFiles = {};
        this.fakes.destroy(device);
    }
}