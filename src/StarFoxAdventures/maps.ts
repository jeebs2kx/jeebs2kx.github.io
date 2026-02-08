import * as Viewer from '../viewer.js';
import * as UI from '../ui.js';

import { DataFetcher } from '../DataFetcher.js';
import { GfxRenderInstManager } from "../gfx/render/GfxRenderInstManager.js";
import { fillSceneParamsDataOnTemplate } from '../gx/gx_render.js';
import { GfxDevice } from '../gfx/platform/GfxPlatform.js';
import { SceneContext } from '../SceneBase.js';
import { mat4, vec3 } from 'gl-matrix';
import { nArray } from '../util.js';
import { White } from '../Color.js';
import { ModelVersion } from "./modelloader.js";
import { SFARenderer, SceneRenderContext, SFARenderLists } from './render.js';
import { BlockFetcher, SFABlockFetcher, SwapcircleBlockFetcher, AncientBlockFetcher, EARLYDFPT, EARLYFEAR, EARLYDUPBLOCKFETCHER, EARLY1BLOCKFETCHER, EARLY2BLOCKFETCHER, EARLY3BLOCKFETCHER, EARLY4BLOCKFETCHER  } from './blocks.js';
import { SFA_GAME_INFO, SFADEMO_GAME_INFO, GameInfo } from './scenes.js';
import { MaterialFactory } from './materials.js';
import { SFAAnimationController } from './animation.js';
import { SFATextureFetcher } from './textures.js';
import { ModelRenderContext, ModelInstance } from './models.js';
import { World } from './world.js';
import { AABB } from '../Geometry.js';
import { LightType } from './WorldLights.js';
import { computeViewMatrix } from '../Camera.js';
import { drawWorldSpacePoint, getDebugOverlayCanvas2D } from '../DebugJunk.js';

export interface BlockInfo {
    mod: number;
    sub: number;
}

export interface MapInfo {
    mapsBin: DataView;
    locationNum: number;
    infoOffset: number;
    blockTableOffset: number;
    blockCols: number;
    blockRows: number;
    originX: number;
    originZ: number;
}

export function getBlockInfo(mapsBin: DataView, mapInfo: MapInfo, x: number, y: number): BlockInfo | null {
    const blockIndex = y * mapInfo.blockCols + x;
    const blockInfo = mapsBin.getUint32(mapInfo.blockTableOffset + 4 * blockIndex);
    const sub = (blockInfo >>> 17) & 0x3F;
    const mod = (blockInfo >>> 23);
    if (mod == 0xff)
        return null;
    return {mod, sub};
}

function getMapInfo(mapsTab: DataView, mapsBin: DataView, locationNum: number): MapInfo {
    const offs = locationNum * 0x1c;
    const infoOffset = mapsTab.getUint32(offs + 0x0);
    const blockTableOffset = mapsTab.getUint32(offs + 0x4);

    const blockCols = mapsBin.getUint16(infoOffset + 0x0);
    const blockRows = mapsBin.getUint16(infoOffset + 0x2);

    return {
        mapsBin, locationNum, infoOffset, blockTableOffset, blockCols, blockRows,
        originX: mapsBin.getInt16(infoOffset + 0x4),
        originZ: mapsBin.getInt16(infoOffset + 0x6),
    };
}

// Block table is addressed by blockTable[y][x].
function getBlockTable(mapInfo: MapInfo): (BlockInfo | null)[][] {
    const blockTable: (BlockInfo | null)[][] = [];
    for (let y = 0; y < mapInfo.blockRows; y++) {
        const row: (BlockInfo | null)[] = [];
        blockTable.push(row);
        for (let x = 0; x < mapInfo.blockCols; x++) {
            const blockInfo = getBlockInfo(mapInfo.mapsBin, mapInfo, x, y);
            row.push(blockInfo);
        }
    }

    return blockTable;
}

// --- Early1 Walled City remap helper -------------------------------
type BlockCell = BlockInfo | null;

/** Build a MapSceneInfo that rearranges a map's blocks.
 *  You can either "pick" cells from the original table, or supply your own mod/sub pairs.
 */
async function buildEarly1WalledCityRemap(
  gameInfo: GameInfo,
  dataFetcher: DataFetcher,
  mapNum: number,
  makeLayout: (pick: (x: number, y: number) => BlockCell) => BlockCell[][]
): Promise<MapSceneInfo> {
  const pathBase = gameInfo.pathBase;
  const [tabBuf, binBuf] = await Promise.all([
    dataFetcher.fetchData(`${pathBase}/MAPS.tab`),
    dataFetcher.fetchData(`${pathBase}/MAPS.bin`),
  ]);

  const mapsTab = tabBuf.createDataView();
  const mapsBin = binBuf.createDataView();
  const info    = getMapInfo(mapsTab, mapsBin, mapNum);
  const src     = getBlockTable(info); // original layout

  const pick = (x: number, y: number): BlockCell => (src[y]?.[x] ?? null);

  const layout = makeLayout(pick);
  const rows   = layout.length;
  const cols   = rows ? layout[0].length : 0;

  return {
    getNumCols() { return cols; },
    getNumRows() { return rows; },
    getBlockInfoAt(col: number, row: number) { return layout[row][col]; },
    getOrigin() { return [0, 0]; }, // tweak if you want to offset
  };
}

const M = (mod: number, sub: number): BlockInfo => ({ mod, sub });


interface MapSceneInfo {
    getNumCols(): number;
    getNumRows(): number;
    getBlockInfoAt(col: number, row: number): BlockInfo | null;
    getOrigin(): number[];
}

interface BlockIter {
    x: number;
    z: number;
    block: ModelInstance;
}

const scratchMtx0 = mat4.create();

export class MapInstance {
    public setBlockFetcher(blockFetcher: BlockFetcher) {
  this.blockFetcher = blockFetcher;
}
    private matrix: mat4 = mat4.create(); // map-to-world
    private invMatrix: mat4 = mat4.create(); // world-to-map
    private numRows: number;
    private numCols: number;
    private blockInfoTable: (BlockInfo | null)[][] = []; // Addressed by blockInfoTable[z][x]
    private blocks: (ModelInstance | null)[][] = []; // Addressed by blocks[z][x]

    constructor(public info: MapSceneInfo, private blockFetcher: BlockFetcher, public world?: World) {
        this.numRows = info.getNumRows();
        this.numCols = info.getNumCols();

        for (let y = 0; y < this.numRows; y++) {
            const row: (BlockInfo | null)[] = [];
            this.blockInfoTable.push(row);
            for (let x = 0; x < this.numCols; x++) {
                const blockInfo = info.getBlockInfoAt(x, y);
                row.push(blockInfo);
            }
        }
    }
    
    public clearBlocks() {
        this.blocks = [];
    }

    public setMatrix(matrix: mat4) {
        mat4.copy(this.matrix, matrix);
        mat4.invert(this.invMatrix, matrix);
    }

    public getNumDrawSteps(): number {
        return 3;
    }

    public* iterateBlocks(): Generator<BlockIter, void> {
        for (let z = 0; z < this.blocks.length; z++) {
            const row = this.blocks[z];
            for (let x = 0; x < row.length; x++) {
                if (row[x] !== null) {
                    yield { x, z, block: row[x]! };
                }
            }
        }
    }

    public getBlockAtPosition(x: number, z: number): ModelInstance | null {
        const bx = Math.floor(x / 640);
        const bz = Math.floor(z / 640);
        const block = this.blocks[bz][bx];
        if (block === undefined) {
            return null;
        }
        return block;
    }

    public addRenderInsts(device: GfxDevice, renderInstManager: GfxRenderInstManager, renderLists: SFARenderLists, modelCtx: ModelRenderContext) {
        modelCtx.cullByAabb = false;
        for (let b of this.iterateBlocks()) {
            mat4.fromTranslation(scratchMtx0, [640 * b.x, 0, 640 * b.z]);
            mat4.mul(scratchMtx0, this.matrix, scratchMtx0);
            b.block.addRenderInsts(device, renderInstManager, modelCtx, renderLists, scratchMtx0);
        }
        modelCtx.cullByAabb = undefined;
    }

    public async reloadBlocks(dataFetcher: DataFetcher) {
        this.clearBlocks();
        for (let z = 0; z < this.numRows; z++) {
            const row: (ModelInstance | null)[] = [];
            this.blocks.push(row);
            for (let x = 0; x < this.numCols; x++) {
                const blockInfo = this.blockInfoTable[z][x];
                if (blockInfo == null) {
                    row.push(null);
                    continue;
                }

                try {
                    const blockModel = await this.blockFetcher.fetchBlock(blockInfo.mod, blockInfo.sub, dataFetcher);
                    if (blockModel) {
                        row.push(new ModelInstance(blockModel));
                    }
                } catch (e) {
                    console.warn(`Skipping block at ${x},${z} due to exception:`);
                    console.error(e);
                }
            }
        }
    }

    public destroy(device: GfxDevice) {
        for (let row of this.blocks) {
            for (let model of row)
                model?.destroy(device);
        }
    }
}

export async function loadMap(gameInfo: GameInfo, dataFetcher: DataFetcher, mapNum: number): Promise<MapSceneInfo> {
    const pathBase = gameInfo.pathBase;
    const [mapsTab, mapsBin] = await Promise.all([
        dataFetcher.fetchData(`${pathBase}/MAPS.tab`),
        dataFetcher.fetchData(`${pathBase}/MAPS.bin`),
    ]);

    const mapInfo = getMapInfo(mapsTab.createDataView(), mapsBin.createDataView(), mapNum);
    const blockTable = getBlockTable(mapInfo);
    return {
        getNumCols() { return mapInfo.blockCols; },
        getNumRows() { return mapInfo.blockRows; },
        getBlockInfoAt(col: number, row: number): BlockInfo | null {
            return blockTable[row][col];
        },
        getOrigin(): number[] {
            return [mapInfo.originX, mapInfo.originZ];
        }
    };
}

class MapSceneRenderer extends SFARenderer {
  public textureHolder?: UI.TextureListHolder;

    private blockFetcherFactory?: () => Promise<BlockFetcher>;
    public setBlockFetcherFactory(factory: () => Promise<BlockFetcher>) {
  this.blockFetcherFactory = factory;
}

    private map: MapInstance;
private dataFetcher!: DataFetcher;
    constructor(context: SceneContext, animController: SFAAnimationController, materialFactory: MaterialFactory) {
        super(context, animController, materialFactory);
    }
public async reloadForTextureToggle(): Promise<void> {
  if (!this.dataFetcher) return;
  if (this.blockFetcherFactory) {
    const fresh = await this.blockFetcherFactory();
    this.map.setBlockFetcher(fresh);
  }
  await this.map.reloadBlocks(this.dataFetcher);
}



    public async create(info: MapSceneInfo, gameInfo: GameInfo, dataFetcher: DataFetcher, blockFetcher: BlockFetcher): Promise<Viewer.SceneGfx> {
        this.dataFetcher = dataFetcher; 
        this.map = new MapInstance(info, blockFetcher);
        await this.map.reloadBlocks(dataFetcher);
        const texFetcher = (blockFetcher as any).texFetcher;
if (texFetcher?.textureHolder)
    this.textureHolder = texFetcher.textureHolder;

        return this;
    }
public createPanels(): UI.Panel[] {
    if (!this.textureHolder)
        return [];

    const texPanel = new UI.Panel();
    texPanel.setTitle(UI.SEARCH_ICON, 'Textures');

    const viewer = new UI.TextureViewer();
    viewer.setTextureHolder(this.textureHolder);

    texPanel.contents.appendChild(viewer.elem);
    return [texPanel];
}

    public setMatrix(matrix: mat4) {
        this.map.setMatrix(matrix);
    }

    protected override update(viewerInput: Viewer.ViewerRenderInput) {
        super.update(viewerInput);
        this.materialFactory.update(this.animController);
    }

    protected override addWorldRenderInsts(device: GfxDevice, renderInstManager: GfxRenderInstManager, renderLists: SFARenderLists, sceneCtx: SceneRenderContext) {
        const template = renderInstManager.pushTemplateRenderInst();
        fillSceneParamsDataOnTemplate(template, sceneCtx.viewerInput);

        const modelCtx: ModelRenderContext = {
            sceneCtx,
            showDevGeometry: false,
            ambienceIdx: 0,
            showMeshes: true,
            outdoorAmbientColor: White,
            setupLights: () => {},
        };

        this.map.addRenderInsts(device, renderInstManager, renderLists, modelCtx);

        renderInstManager.popTemplateRenderInst();
    }
}
function ensureTextureToggleUI(
  onChange: (enabled: boolean) => void | Promise<void>,
  initial?: boolean
): void {
  type ToggleState = {
    wrap: HTMLDivElement;
    cb: HTMLInputElement;
    handler: ((e: Event) => void) | null;
    last?: boolean;
  };

  let state = (window as any).__sfaTextureToggle as ToggleState | undefined;

  if (!state) {
    const wrap = document.createElement('div');
    wrap.style.position = 'fixed';
    wrap.style.top = '2px';
    wrap.style.right = '2px';
    wrap.style.zIndex = '10000';
    wrap.style.padding = '2px 4px';
    wrap.style.background = 'rgba(0,0,0,0.5)';
    wrap.style.color = '#fff';
    wrap.style.font = '12px sans-serif';
    wrap.style.borderRadius = '2px';

    const label = document.createElement('label');
    label.style.cursor = 'pointer';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.style.marginRight = '2px';

    label.appendChild(cb);
    label.appendChild(document.createTextNode('Textures'));
    wrap.appendChild(label);
    document.body.appendChild(wrap);

    state = { wrap, cb, handler: null, last: true };
    (window as any).__sfaTextureToggle = state;
  }

  // Detach previous handler (from the old scene) if any.
  if (state.handler) state.cb.removeEventListener('change', state.handler);

  // Set initial checkbox state (use provided value or preserve last).
  const desired = (typeof initial === 'boolean') ? initial : (state.last ?? true);
  state.cb.checked = desired;

  // Bind the new scene's handler.
  state.handler = async () => {
    try {
      state!.last = state!.cb.checked;
      await onChange(state!.cb.checked);
    } catch (e) {
      console.error('Texture toggle handler error:', e);
    }
  };
  state.cb.addEventListener('change', state.handler);
}


export class SFAMapSceneDesc implements Viewer.SceneDesc {
    constructor(public mapNum: number, public id: string, public name: string, private gameInfo: GameInfo = SFA_GAME_INFO) {
    }

    public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {
        console.log(`Creating scene for ${this.name} (map #${this.mapNum}) ...`);

        const animController = new SFAAnimationController();
        const materialFactory = new MaterialFactory(device);
        const mapSceneInfo = await loadMap(this.gameInfo, context.dataFetcher, this.mapNum);

        const mapRenderer = new MapSceneRenderer(context, animController, materialFactory);
        const texFetcher = await SFATextureFetcher.create(this.gameInfo, context.dataFetcher, false);
        
        const blockFetcher = await SFABlockFetcher.create(this.gameInfo,context.dataFetcher, device, materialFactory, animController, Promise.resolve(texFetcher));
        await mapRenderer.create(mapSceneInfo, this.gameInfo, context.dataFetcher, blockFetcher);

        // Rotate camera 135 degrees to more reliably produce a good view of the map
        // when it is loaded for the first time.
        const matrix = mat4.create();
        mat4.rotateY(matrix, matrix, Math.PI * 3 / 4);
        mapRenderer.setMatrix(matrix);

        return mapRenderer;
    }
    
}


export class SwapcircleSceneDesc implements Viewer.SceneDesc {
  constructor(
    public mapNum: number,
    public id: string,
    public name: string,
    private gameInfo: GameInfo = SFADEMO_GAME_INFO
  ) {}

  public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {
    console.log(`Creating scene for ${this.name} (map #${this.mapNum}) ...`);

    const animController = new SFAAnimationController();
    const materialFactory = new MaterialFactory(device);

    const COLS = 4;
    const ROWS = 3;

    const allowedSubs = [19, 7, 8, 20, 0, 12, 13, 0, 0, 17, 18, 0];
   

    const mapSceneInfo: MapSceneInfo = {
      getNumCols() { return COLS; },
      getNumRows() { return ROWS; },
getBlockInfoAt(col: number, row: number): BlockInfo | null {
  const idx = (row * COLS + col) % allowedSubs.length;
  const sub = allowedSubs[idx];

  // Treat 0 as “empty cell”
  if (sub === 0)
    return null;

  return { mod: 22, sub };
},
      getOrigin(): number[] { return [0, 0]; },
    };

    const mapRenderer = new MapSceneRenderer(context, animController, materialFactory);
    const texFetcher = await SFATextureFetcher.create(this.gameInfo, context.dataFetcher, true);
    await texFetcher.loadSubdirs(['swapcircle'], context.dataFetcher);
    texFetcher.logAllTex1TextureIDs();

    const blockFetcher = await SwapcircleBlockFetcher.create(
      this.gameInfo, context.dataFetcher, materialFactory, texFetcher
    );
    await mapRenderer.create(mapSceneInfo, this.gameInfo, context.dataFetcher, blockFetcher);

    return mapRenderer;
  }
}


export class AncientMapSceneDesc implements Viewer.SceneDesc {
    constructor(public id: string, public name: string, private gameInfo: GameInfo, private mapKey: any) {
    }
    
    public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {
        console.log(`Creating scene for ${this.name} ...`);

        const pathBase = this.gameInfo.pathBase;
        const dataFetcher = context.dataFetcher;
        const mapsJsonBuffer = await dataFetcher.fetchData(`${pathBase}/AncientMaps.json`);

        const animController = new SFAAnimationController();
        const materialFactory = new MaterialFactory(device);

        const mapsJsonString = new TextDecoder('utf-8').decode(mapsJsonBuffer.arrayBuffer as ArrayBuffer);
        const mapsJson = JSON.parse(mapsJsonString);
        const map = mapsJson[this.mapKey];

        const numRows = map.blocks.length;
        const numCols = map.blocks[0].length;
        const blockTable: (BlockInfo | null)[][] = nArray(numRows, () => nArray(numCols, () => null));

        for (let row = 0; row < numRows; row++) {
            for (let col = 0; col < numCols; col++) {
                const b = map.blocks[row][col];
                if (b == null) {
                    blockTable[row][col] = null;
                } else {
                    const newValue = b.split('.', 2);
                    const newMod = Number.parseInt(newValue[0]);
                    const newSub = Number.parseInt(newValue[1]);
                    blockTable[row][col] = {mod: newMod, sub: newSub};
                }
            }
        }

        const mapSceneInfo: MapSceneInfo = {
            getNumCols() { return numCols; },
            getNumRows() { return numRows; },
            getBlockInfoAt(col: number, row: number): BlockInfo | null {
                return blockTable[row][col];
            },
            getOrigin(): number[] {
                return [0, 0];
            }
        };

const mapRenderer = new MapSceneRenderer(context, animController, materialFactory);

const texFetcher = await SFATextureFetcher.create(this.gameInfo, dataFetcher, false);
texFetcher.setModelVersion(ModelVersion.AncientMap);

await texFetcher.loadSubdirs(
  ['cloudrace','icemountain','swaphol','crfort','warlock','nwastes', 'shop', 'capeclaw' ],
  dataFetcher
);
texFetcher.logAllTex1TextureIDs();
texFetcher.setPngOverride(4100, 'textures/ribbon.png');
texFetcher.setPngOverride(618, 'textures/walls.png');
texFetcher.setPngOverride(617, 'textures/floor1.png');
texFetcher.setPngOverride(616, 'textures/pillar.png');
texFetcher.setPngOverride(615, 'textures/transwall.png');
texFetcher.setPngOverride(614, 'textures/support.png');
texFetcher.setPngOverride(613, 'textures/chain.png');
texFetcher.setPngOverride(612, 'textures/head.png');
texFetcher.setPngOverride(611, 'textures/krazfloor.png');
texFetcher.setPngOverride(610, 'textures/decor1.png');
texFetcher.setPngOverride(609, 'textures/floor2.png');
texFetcher.setPngOverride(608, 'textures/ceiling1.png');
texFetcher.setPngOverride(607, 'textures/walls2.png');
texFetcher.setPngOverride(606, 'textures/pillar2.png');
texFetcher.setPngOverride(605, 'textures/wood.png');
texFetcher.setPngOverride(604, 'textures/button.png');
texFetcher.setPngOverride(603, 'textures/sash.png');
texFetcher.setPngOverride(602, 'textures/floor3.png');
texFetcher.setPngOverride(601, 'textures/vines.png');
texFetcher.setPngOverride(600, 'textures/walls3.png');
texFetcher.setPngOverride(599, 'textures/block.png');
texFetcher.setPngOverride(598, 'textures/innerdoor.png');
texFetcher.setPngOverride(597, 'textures/stained.png');
texFetcher.setPngOverride(596, 'textures/spire.png');
texFetcher.setPngOverride(595, 'textures/crates.png');
texFetcher.setPngOverride(591, 'textures/sabrestart.png');
texFetcher.setPngOverride(590, 'textures/walls4.png');
texFetcher.setPngOverride(589, 'textures/floor4.png');
texFetcher.setPngOverride(588, 'textures/floor5.png');
texFetcher.setPngOverride(587, 'textures/walls5.png');
texFetcher.setPngOverride(586, 'textures/kraz.png');
texFetcher.setPngOverride(585, 'textures/black.png');
texFetcher.setPngOverride(584, 'textures/transring.png');
texFetcher.setPngOverride(583, 'textures/spire2.png');
texFetcher.setPngOverride(582, 'textures/kraz2.png');
texFetcher.setPngOverride(581, 'textures/kraz3.png');
texFetcher.setPngOverride(580, 'textures/port.png');
texFetcher.setPngOverride(579, 'textures/floor6.png');
texFetcher.setPngOverride(3001, 'textures/shoppurple.png'); 
texFetcher.setPngOverride(3002, 'textures/shopwood.png'); 
texFetcher.setPngOverride(3003, 'textures/shoppurple2.png'); 
texFetcher.setPngOverride(3004, 'textures/shoppurple3.png'); 
texFetcher.setPngOverride(3005, 'textures/shoppurple4.png'); 
texFetcher.setPngOverride(3006, 'textures/shoppurple5.png'); 
texFetcher.setPngOverride(2037, 'textures/wgfloor1.png');
texFetcher.setPngOverride(2036, 'textures/wgfloor2.png');
texFetcher.setPngOverride(2035, 'textures/wgfloor3.png');
texFetcher.setPngOverride(2034, 'textures/wgwall1.png');
texFetcher.setPngOverride(2033, 'textures/wgwall2.png');
texFetcher.setPngOverride(2032, 'textures/wgwall3.png');
texFetcher.setPngOverride(2031, 'textures/wgwall4.png');
texFetcher.setPngOverride(2030, 'textures/wgfloor4.png');
texFetcher.setPngOverride(2029, 'textures/wgwall5.png');
texFetcher.setPngOverride(2028, 'textures/wgfloor5.png');
texFetcher.setPngOverride(2027, 'textures/wgdirt.png');
texFetcher.setPngOverride(2026, 'textures/wgfloor6.png');
texFetcher.setPngOverride(2025, 'textures/wgwall6.png');
texFetcher.setPngOverride(2024, 'textures/wgwall7.png');
texFetcher.setPngOverride(2023, 'textures/wgwall8.png');
texFetcher.setPngOverride(2022, 'textures/wgwall9.png');
texFetcher.setPngOverride(2021, 'textures/wgrock.png');
texFetcher.setPngOverride(2020, 'textures/wgwall10.png');
texFetcher.setPngOverride(2019, 'textures/wgwall11.png');
texFetcher.setPngOverride(2018, 'textures/wgfloor7.png');
texFetcher.setPngOverride(2017, 'textures/wgwall12.png');
texFetcher.setPngOverride(2016, 'textures/wgwall13.png');
texFetcher.setPngOverride(2015, 'textures/wgvines.png');
texFetcher.setPngOverride(2014, 'textures/wgwall14.png');
texFetcher.setPngOverride(2013, 'textures/wgwall15.png');
texFetcher.setPngOverride(2012, 'textures/wgwall16.png');
texFetcher.setPngOverride(2011, 'textures/wgwall17.png');
texFetcher.setPngOverride(2010, 'textures/wgwall18.png');
texFetcher.setPngOverride(2009, 'textures/wgwall19.png');
texFetcher.setPngOverride(2008, 'textures/wgwall20.png');
texFetcher.setPngOverride(2007, 'textures/wgwall21.png');
texFetcher.setPngOverride(2006, 'textures/wgwall22.png');
texFetcher.setPngOverride(2005, 'textures/wgwall23.png');
texFetcher.setPngOverride(2004, 'textures/wgrim.png');
texFetcher.setPngOverride(2003, 'textures/wghead.png');
texFetcher.setPngOverride(2002, 'textures/wghead2.png');
texFetcher.setPngOverride(2001, 'textures/wghead3.png');
texFetcher.setPngOverride(2000, 'textures/wghead4.png');

await texFetcher.preloadPngOverrides((materialFactory as any).cache ?? (materialFactory as any).getCache?.(), dataFetcher);

const blockFetcher = await AncientBlockFetcher.create(
  this.gameInfo, dataFetcher, materialFactory, Promise.resolve(texFetcher)
);
mapRenderer.setBlockFetcherFactory(() => AncientBlockFetcher.create(
  this.gameInfo, dataFetcher, materialFactory, Promise.resolve(texFetcher)
));


await mapRenderer.create(mapSceneInfo, this.gameInfo, dataFetcher, blockFetcher);
ensureTextureToggleUI(async (enabled: boolean) => {
  texFetcher.setTexturesEnabled(enabled);
  materialFactory.texturesEnabled = enabled;
  await mapRenderer.reloadForTextureToggle();
}, texFetcher.getTexturesEnabled?.() ?? true);


        // Rotate camera 135 degrees to more reliably produce a good view of the map
        // when it is loaded for the first time.
        // FIXME: The best method is to create default save states for each map.
        const matrix = mat4.create();
        mat4.rotateY(matrix, matrix, Math.PI * 3 / 4);
        mapRenderer.setMatrix(matrix);

        return mapRenderer;
    }
}

export class EarlyfearMapSceneDesc implements Viewer.SceneDesc {
    constructor(public mapNum: number, public id: string, public name: string, private gameInfo: GameInfo = SFA_GAME_INFO) {
    }

    public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {
        console.log(`Creating scene for ${this.name} (map #${this.mapNum}) ...`);

        const animController = new SFAAnimationController();
        const materialFactory = new MaterialFactory(device);
        const mapSceneInfo = await loadMap(this.gameInfo, context.dataFetcher, this.mapNum);

        const mapRenderer = new MapSceneRenderer(context, animController, materialFactory);
        const texFetcher = await SFATextureFetcher.create(this.gameInfo, context.dataFetcher, false);
  texFetcher.setModelVersion(ModelVersion.fear);
await texFetcher.loadSubdirs([ 'mmshrine'],  context.dataFetcher);
texFetcher.logAllTex1TextureIDs();
        const blockFetcher = await EARLYFEAR.create(this.gameInfo,context.dataFetcher, device, materialFactory, animController, Promise.resolve(texFetcher));
        await mapRenderer.create(mapSceneInfo, this.gameInfo, context.dataFetcher, blockFetcher);

        // Rotate camera 135 degrees to more reliably produce a good view of the map
        // when it is loaded for the first time.
        const matrix = mat4.create();
        mat4.rotateY(matrix, matrix, Math.PI * 3 / 4);
        mapRenderer.setMatrix(matrix);

        return mapRenderer;
    }
}


export class EarlyDFPMapSceneDesc implements Viewer.SceneDesc {
    constructor(public mapNum: number, public id: string, public name: string, private gameInfo: GameInfo = SFA_GAME_INFO) {
    }

public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {
  console.log(`Creating scene for ${this.name} (map #${this.mapNum}) ...`);

  const animController = new SFAAnimationController();
  const materialFactory = new MaterialFactory(device);
  const mapSceneInfo = await loadMap(this.gameInfo, context.dataFetcher, this.mapNum);
  const mapRenderer = new MapSceneRenderer(context, animController, materialFactory);

  const texFetcher = await SFATextureFetcher.create(this.gameInfo, context.dataFetcher, false);
  texFetcher.setModelVersion(ModelVersion.dfpt);
await texFetcher.loadSubdirs([''], context.dataFetcher);
texFetcher.logAllTex1TextureIDs();

  texFetcher.setPngOverride(4000, 'textures/dfprim.png');
  texFetcher.setPngOverride(4001, 'textures/dfpwall.png');
  texFetcher.setPngOverride(4002, 'textures/dfpwall2.png');
  texFetcher.setPngOverride(4003, 'textures/dfpfloor.png');
  texFetcher.setPngOverride(4004, 'textures/dfpwall3.png');
  texFetcher.setPngOverride(4005, 'textures/dfpdecor.png');
  texFetcher.setPngOverride(4006, 'textures/dfpwall4.png');
  texFetcher.setPngOverride(4007, 'textures/dfppillar.png');
  texFetcher.setPngOverride(4008, 'textures/dfpkraz.png');
  texFetcher.setPngOverride(4009, 'textures/dfpkraz2.png');
  texFetcher.setPngOverride(4010, 'textures/dfppost.png');
  texFetcher.setPngOverride(4011, 'textures/dfpstatue.png');
  texFetcher.setPngOverride(4012, 'textures/dfpstatue2.png');
  texFetcher.setPngOverride(4013, 'textures/dfpbuttons.png');
     await texFetcher.preloadPngOverrides(
      (materialFactory as any).cache ?? (materialFactory as any).getCache?.(),
      context.dataFetcher
    );

  const blockFetcher = await EARLYDFPT.create(
    this.gameInfo, context.dataFetcher, device, materialFactory, animController, Promise.resolve(texFetcher)
  );

  await mapRenderer.create(mapSceneInfo, this.gameInfo, context.dataFetcher, blockFetcher);

  const matrix = mat4.create();
  mat4.rotateY(matrix, matrix, Math.PI * 3 / 4);
  mapRenderer.setMatrix(matrix);

  return mapRenderer;
}
    
}

export class EarlydupMapSceneDesc implements Viewer.SceneDesc {
    constructor(public mapNum: number, public id: string, public name: string, private gameInfo: GameInfo = SFA_GAME_INFO) {
    }

public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {
  console.log(`Creating scene for ${this.name} (map #${this.mapNum}) ...`);

  const animController = new SFAAnimationController();
  const materialFactory = new MaterialFactory(device);

  // === Add your custom DUP maps here ===
  const REMAP_FEAR_SHRINE = 32;   
  const REMAP_KNOWLEDGE    = 34; 
  const REMAP_STRENGTH    = 39;   

  let mapSceneInfo: MapSceneInfo;

  switch (this.mapNum) {
    case REMAP_FEAR_SHRINE: {
      // Your current 2x4 layout
      mapSceneInfo = {
        getNumCols() { return 2; },
        getNumRows() { return 4; },
        getBlockInfoAt(col, row) {
          const L: (BlockCell)[][] = [
            [ M(40,0), M(40,1) ],
            [ M(40,2), M(40,3) ],
            [ M(40,4), M(40,5) ],
            [ M(40,6), M(40,7) ],
          ];
          return L[row][col];
        },
        getOrigin() { return [0, 0]; },
      };
      break;
    }

    case REMAP_KNOWLEDGE: {
      mapSceneInfo = {
        getNumCols() { return 2; },
        getNumRows() { return 4; },
        getBlockInfoAt(col, row) {
          const L: (BlockCell)[][] = [
            [ M(42,0), M(42,1) ],
            [ M(42,2), M(42,3) ],
            [ M(42,4), M(42,5) ],
            [ M(42,6), M(42,7) ],
          ];
          return L[row][col];
        },
        getOrigin() { return [0, 0]; },
      };
      break;
    }
    case REMAP_STRENGTH: {
      mapSceneInfo = {
        getNumCols() { return 2; },
        getNumRows() { return 4; },
        getBlockInfoAt(col, row) {
          const L: (BlockCell)[][] = [
            [ M(43,0), M(43,1) ],
            [ M(43,2), M(43,3) ],
            [ M(43,4), M(43,5) ],
            [ M(43,6), M(43,7) ],
          ];
          return L[row][col];
        },
        getOrigin() { return [0, 0]; },
      };
      break;
    }

    default:
      mapSceneInfo = await loadMap(this.gameInfo, context.dataFetcher, this.mapNum);
      break;
  }

    const mapRenderer = new MapSceneRenderer(context, animController, materialFactory);
    const texFetcher  = await SFATextureFetcher.create(this.gameInfo, context.dataFetcher, false);

    texFetcher.setModelVersion(ModelVersion.dup);
    texFetcher.setCurrentModelID(this.mapNum);  
    await texFetcher.loadSubdirs([''], context.dataFetcher);
    texFetcher.logAllTex1TextureIDs();

texFetcher.setPngOverride(3614, 'textures/MMSHfloor.png');

     await texFetcher.preloadPngOverrides(
      (materialFactory as any).cache ?? (materialFactory as any).getCache?.(),
      context.dataFetcher
    );

  // Build with the same texFetcher instance (and keep it for rebuilds/toggles).
  const blockFetcher = await EARLYDUPBLOCKFETCHER.create(
    this.gameInfo, context.dataFetcher, device, materialFactory, animController, Promise.resolve(texFetcher)
  );
  mapRenderer.setBlockFetcherFactory(() =>
    EARLYDUPBLOCKFETCHER.create(
      this.gameInfo, context.dataFetcher, device, materialFactory, animController, Promise.resolve(texFetcher)
    )
  );

  await mapRenderer.create(mapSceneInfo, this.gameInfo, context.dataFetcher, blockFetcher);

  // Texture toggle UI — exactly like Early1: will rebuild with the same fetcher so overrides persist.
  ensureTextureToggleUI(async (enabled: boolean) => {
    texFetcher.setTexturesEnabled(enabled);
    (materialFactory as any).texturesEnabled = enabled;
    await mapRenderer.reloadForTextureToggle();
  }, texFetcher.getTexturesEnabled?.() ?? true);

  // Default camera turn
  const matrix = mat4.create();
  mat4.rotateY(matrix, matrix, Math.PI * 3 / 4);
  mapRenderer.setMatrix(matrix);

  return mapRenderer;
}
}


export class Early1MapSceneDesc implements Viewer.SceneDesc {
  constructor(public mapNum: number, public id: string, public name: string, private gameInfo: GameInfo = SFA_GAME_INFO) {}

  public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {
    console.log(`Creating scene for ${this.name} (map #${this.mapNum}) ...`);

    const animController  = new SFAAnimationController();
    const materialFactory = new MaterialFactory(device);

    const REMAP_WALLED_CITY = 13;
    const REMAP_COMBAT      = 31;
    const REMAP_SAMPLE      = 29; 

    let mapSceneInfo: MapSceneInfo;

    switch (this.mapNum) {
      case REMAP_WALLED_CITY: {
        mapSceneInfo = {
          getNumCols() { return 9; },
          getNumRows() { return 9; },
          getBlockInfoAt(col, row) {
            const L: (BlockCell)[][] = [
              [ M(20,1),  M(20,4),  null,     null,     M(20,19), null,     null,     null,     null ],
              [ M(20,0),  M(20,3),  null,     M(20,12), M(20,18), M(20,25), null,     null,     null ],
              [ M(20,32), M(20,2),  M(20,5),  M(20,11), M(20,17), M(20,24), M(20,26), M(20,29), M(20,33) ],
              [ null,     null,     null,     M(20,10), M(20,16), M(20,23), null,     M(20,28), M(20,31) ],
              [ null,     null,     null,     M(20,9),  M(20,15), M(20,22), null,     M(20,27), M(20,30) ],
              [ null,     null,     null,     M(20,8),  M(20,14), M(20,21), null,     null,     null ],
              [ null,     null,     null,     M(20,7),  M(20,13), M(20,20), null,     null,     null ],
              [ null,     null,     null,     M(20,6),  null,     null,     null,     null,     null ],
              [ null,     null,     null,     null,     null,     null,     null,     null,     null ],
            ];
            return L[row][col];
          },
          getOrigin() { return [0, 0]; },
        };
        break;
      }

    case REMAP_COMBAT: {
      mapSceneInfo = {
        getNumCols() { return 2; },
        getNumRows() { return 4; },
        getBlockInfoAt(col, row) {
          const L: (BlockCell)[][] = [
            [ M(39,0), M(39,1) ],
            [ M(39,2), M(39,3) ],
            [ M(39,4), M(39,5) ],
            [ M(39,6), M(39,7) ],
          ];
          return L[row][col];
        },
        getOrigin() { return [0, 0]; },
      };
      break;
      }



      default: {
        // Fallback to the map's native layout
        mapSceneInfo = await loadMap(this.gameInfo, context.dataFetcher, this.mapNum);
        break;
      }
    }

    // --- Renderer + textures (same as before) ---
    const mapRenderer = new MapSceneRenderer(context, animController, materialFactory);
    const texFetcher  = await SFATextureFetcher.create(this.gameInfo, context.dataFetcher, false);

    texFetcher.setModelVersion(ModelVersion.Early1);
    texFetcher.setCurrentModelID(this.mapNum);  
    await texFetcher.loadSubdirs([''], context.dataFetcher);
    texFetcher.logAllTex1TextureIDs();

const SWAPHOL_EARLY1_MAPNUM =  7;


if (this.mapNum === SWAPHOL_EARLY1_MAPNUM) {
  await texFetcher.loadSubdirs(['swaphol'], context.dataFetcher);
  texFetcher.preferCopyOfSwapholForModelIDs([SWAPHOL_EARLY1_MAPNUM]);
}

    texFetcher.setPngOverride(3000, 'textures/wcblue.png');
    texFetcher.setPngOverride(3500, 'textures/wcfloor.png');
        texFetcher.setPngOverride(3501, 'textures/wcredrims.png');
           texFetcher.setPngOverride(3611, 'textures/wcrims.png');
           texFetcher.setPngOverride(3612, 'textures/DIMladder.png');
           texFetcher.setPngOverride(3613, 'textures/DIMwall.png');
texFetcher.setPngOverride(3614, 'textures/MMSHfloor.png');

     await texFetcher.preloadPngOverrides(
      (materialFactory as any).cache ?? (materialFactory as any).getCache?.(),
      context.dataFetcher
    );

    const blockFetcher = await EARLY1BLOCKFETCHER.create(
      this.gameInfo, context.dataFetcher, device, materialFactory, animController, Promise.resolve(texFetcher)
    );
mapRenderer.setBlockFetcherFactory(() => EARLY1BLOCKFETCHER.create(
  this.gameInfo, context.dataFetcher, device, materialFactory, animController, Promise.resolve(texFetcher)
));

    await mapRenderer.create(mapSceneInfo, this.gameInfo, context.dataFetcher, blockFetcher);

ensureTextureToggleUI(async (enabled: boolean) => {
  texFetcher.setTexturesEnabled(enabled);
  materialFactory.texturesEnabled = enabled; 
  await mapRenderer.reloadForTextureToggle();
}, texFetcher.getTexturesEnabled?.() ?? true);


    const matrix = mat4.create();
    mat4.rotateY(matrix, matrix, Math.PI * 3 / 4);
    mapRenderer.setMatrix(matrix);

    return mapRenderer;
  }
}



export class Early2MapSceneDesc implements Viewer.SceneDesc {
    constructor(public mapNum: number, public id: string, public name: string, private gameInfo: GameInfo = SFA_GAME_INFO) {
    }

    public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {
        console.log(`Creating scene for ${this.name} (map #${this.mapNum}) ...`);

        const animController = new SFAAnimationController();
        const materialFactory = new MaterialFactory(device);
    const earyl2DRB =  52;

    let mapSceneInfo: MapSceneInfo;
    if (this.mapNum === earyl2DRB) {

       mapSceneInfo = {
         getNumCols() { return 5; },
         getNumRows() { return 5; },
         getBlockInfoAt(col, row) {
           const L: (BlockCell)[][] = [
             [ null, M(10,0), M(10,1), null ],
             [  M(10,14), M(10,2), M(10,3), M(10,15), ],
              [  M(10,4), M(10,5), M(10,6), M(10,12), ],
               [  M(10,10), M(10,7), M(10,8), M(10,13), ],
               [  null, M(10,9), M(10,11),null ],
           ];
           return L[row][col];
         },
         getOrigin() { return [0, 0]; },
       };

    } else {

      mapSceneInfo = await loadMap(this.gameInfo, context.dataFetcher, this.mapNum);
    }
        const mapRenderer = new MapSceneRenderer(context, animController, materialFactory);
        const texFetcher = await SFATextureFetcher.create(this.gameInfo, context.dataFetcher, false);
       texFetcher.setModelVersion(ModelVersion.Early2);
await texFetcher.loadSubdirs([''], context.dataFetcher);
texFetcher.logAllTex1TextureIDs();
    
        const blockFetcher = await EARLY2BLOCKFETCHER.create(this.gameInfo,context.dataFetcher, device, materialFactory, animController, Promise.resolve(texFetcher));
        await mapRenderer.create(mapSceneInfo, this.gameInfo, context.dataFetcher, blockFetcher);

        // Rotate camera 135 degrees to more reliably produce a good view of the map
        // when it is loaded for the first time.
        const matrix = mat4.create();
        mat4.rotateY(matrix, matrix, Math.PI * 3 / 4);
        mapRenderer.setMatrix(matrix);

        return mapRenderer;
    }
}
export class Early3MapSceneDesc implements Viewer.SceneDesc {
  constructor(
    public mapNum: number,
    public id: string,
    public name: string,
    private gameInfo: GameInfo = SFA_GAME_INFO
  ) {}

  public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {
    console.log(`Creating scene for ${this.name} (map #${this.mapNum}) ...`);

    const animController = new SFAAnimationController();
    const materialFactory = new MaterialFactory(device);

    const REMAP_LINK_C     = 67; 

    let mapSceneInfo: MapSceneInfo;

    switch (this.mapNum) {
      case REMAP_LINK_C: {
        mapSceneInfo = {
          getNumCols() { return 1; },
          getNumRows() { return 3; },
          getBlockInfoAt(col, row) {
            const L: (BlockCell)[][] = [
              [ M(65,0), ],
              [ M(65,1), ],
              [ M(65,2), ],
            ];
            return L[row][col];
          },
          getOrigin() { return [0, 0]; },
        };
        break;
      }
      default: {
        // Fallback to the map's native layout
        mapSceneInfo = await loadMap(this.gameInfo, context.dataFetcher, this.mapNum);
        break;
      }
    }

    const mapRenderer = new MapSceneRenderer(context, animController, materialFactory);

    const texFetcher = await SFATextureFetcher.create(this.gameInfo, context.dataFetcher, false);
    texFetcher.setModelVersion(ModelVersion.Early3);
    await texFetcher.loadSubdirs([''], context.dataFetcher);
    texFetcher.logAllTex1TextureIDs();

    texFetcher.setPngOverride(3600, 'textures/dim2wall.png');
    texFetcher.setPngOverride(3500, 'textures/wcfloor.png');
    
     await texFetcher.preloadPngOverrides(
      (materialFactory as any).cache ?? (materialFactory as any).getCache?.(),
      context.dataFetcher
    );

    const blockFetcher = await EARLY3BLOCKFETCHER.create(
      this.gameInfo, context.dataFetcher, device, materialFactory, animController, Promise.resolve(texFetcher)
    );

    // Let the renderer rebuild blocks if textures are toggled later
    mapRenderer.setBlockFetcherFactory(() =>
      EARLY3BLOCKFETCHER.create(
        this.gameInfo, context.dataFetcher, device, materialFactory, animController, Promise.resolve(texFetcher)
      )
    );

    await mapRenderer.create(mapSceneInfo, this.gameInfo, context.dataFetcher, blockFetcher);

    // Optional: same toggle UI used in your other scenes
    ensureTextureToggleUI(async (enabled: boolean) => {
      texFetcher.setTexturesEnabled(enabled);
      (materialFactory as any).texturesEnabled = enabled;
      await mapRenderer.reloadForTextureToggle();
    }, texFetcher.getTexturesEnabled?.() ?? true);

    // Default camera turn
    const matrix = mat4.create();
    mat4.rotateY(matrix, matrix, Math.PI * 3 / 4);
    mapRenderer.setMatrix(matrix);

    return mapRenderer;
  }
}

export class Early4MapSceneDesc implements Viewer.SceneDesc {
    constructor(public mapNum: number, public id: string, public name: string, private gameInfo: GameInfo = SFA_GAME_INFO) {
    }

    public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {
        console.log(`Creating scene for ${this.name} (map #${this.mapNum}) ...`);

        const animController = new SFAAnimationController();
        const materialFactory = new MaterialFactory(device);
        const mapSceneInfo = await loadMap(this.gameInfo, context.dataFetcher, this.mapNum);

        const mapRenderer = new MapSceneRenderer(context, animController, materialFactory);
                const texFetcher = await SFATextureFetcher.create(this.gameInfo, context.dataFetcher, false);
    texFetcher.setModelVersion(ModelVersion.Early4);
    await texFetcher.loadSubdirs([''], context.dataFetcher);
    texFetcher.logAllTex1TextureIDs();
texFetcher.setCurrentModelID(this.mapNum);

    texFetcher.setPngOverride(3610, 'textures/wcbluehead.png');
   texFetcher.setPngOverride(3611, 'textures/wcrims.png');
   texFetcher.setPngOverride(3612, 'textures/wcmoon1.png');
   texFetcher.setPngOverride(3613, 'textures/wcmoon2.png');
    texFetcher.setPngOverride(3614, 'textures/wcmoon3.png');


     await texFetcher.preloadPngOverrides(
      (materialFactory as any).cache ?? (materialFactory as any).getCache?.(),
      context.dataFetcher
    );

        const blockFetcher = await EARLY4BLOCKFETCHER.create(this.gameInfo,context.dataFetcher, device, materialFactory, animController, Promise.resolve(texFetcher));
        await mapRenderer.create(mapSceneInfo, this.gameInfo, context.dataFetcher, blockFetcher);

        // Rotate camera 135 degrees to more reliably produce a good view of the map
        // when it is loaded for the first time.
       const matrix = mat4.create();
        mat4.rotateY(matrix, matrix, Math.PI * 3 / 4);
        mapRenderer.setMatrix(matrix);

        return mapRenderer;
    }
}