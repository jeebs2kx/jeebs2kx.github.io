import { mat4, vec3 } from 'gl-matrix';
import * as UI from '../ui.js';
import * as Viewer from "../viewer.js";
import { GfxDevice } from '../gfx/platform/GfxPlatform.js';
import { GfxRenderInstManager, GfxRenderInst } from "../gfx/render/GfxRenderInstManager.js";
import { SceneContext } from '../SceneBase.js';
import { Color, White, colorCopy, colorNewCopy } from '../Color.js';
import { getDebugOverlayCanvas2D, drawWorldSpaceLine, drawWorldSpacePoint } from '../DebugJunk.js';
import { fillSceneParamsDataOnTemplate } from "../gx/gx_render.js"; // Corrected import syntax
import { Light, lightSetDistAttn, lightSetSpot } from '../gx/gx_material.js';

import { GameInfo, SFA_GAME_INFO } from './scenes.js';
import { Anim, SFAAnimationController, AnimCollection, AmapCollection, ModanimCollection, applyAnimationToModel } from './animation.js';
import { SFARenderer, SceneRenderContext, SFARenderLists } from './render.js';
import { ModelFetcher, ModelInstance, ModelRenderContext, ModelShapes, } from './models.js';
import { Shape, } from './shapes.js';
import { MaterialFactory } from './materials.js';
import { dataSubarray, readUint16 } from './util.js';
import { TextureFetcher, SFATextureFetcher } from './textures.js';
import { ModelVersion } from "./modelloader.js"; // Corrected import syntax
import { downloadBufferSlice } from '../DownloadUtils.js';
import ArrayBufferSlice from '../ArrayBufferSlice.js';

class ModelExhibitRenderer extends SFARenderer {
private turntableEnabled = false;
private turntableAngle = 0;            
private turntableSpeed = Math.PI / 8;   

    private modelInst: ModelInstance | null | undefined = undefined;
    private modelNum = 1;
    private modelSelect: UI.TextEntry;

    private modanim: DataView | null = null;
    private amap: DataView | null = null;
    private generatedAmap: DataView | null = null;
    private anim: Anim | null = null;
    private modelAnimNum = 0;
    private animSelect: UI.TextEntry;

    private displayBones: boolean = false;
    private useGlobalAnimNum: boolean = false;
    private autogenAmap: boolean = false;

    private hasInitializedCamera: boolean = false; 


constructor(
    private context: SceneContext,
    animController: SFAAnimationController,
    public override materialFactory: MaterialFactory,
    private texFetcher: TextureFetcher,
    private modelFetcher: ModelFetcher,
    private animColl: AnimCollection,
    private amapColl: AmapCollection,
    private modanimColl: ModanimCollection,
    private gameInfo: GameInfo,
    private modelVersion: ModelVersion
) {
    super(context, animController, materialFactory);
    (this.animController.animController as any).playbackEnabled = true;
        (this.animController.animController as any).playbackEnabled = true;
    }

    public createPanels(): UI.Panel[] {
        const panel = new UI.Panel();

        panel.setTitle(UI.SAND_CLOCK_ICON, 'Model Viewer');
panel.elem.style.maxWidth = '300px';
panel.elem.style.width = '300px'; // Or fixed like '280px'


        this.modelSelect = new UI.TextEntry();
        this.modelSelect.ontext = (s: string) => {
            const newNum = Number.parseInt(s);
            if (!Number.isNaN(newNum)) {
                this.destroyCurrentModelResources(this.context.device); 
                this.modelNum = newNum;
                console.log(`Requested model change to: ${this.modelNum}`);
            }
        };


        const modelInputWrap = document.createElement('div');
        modelInputWrap.innerHTML = `<label>Model Number:</label>`;
        modelInputWrap.appendChild(this.modelSelect.elem);
        panel.contents.append(modelInputWrap);

        this.animSelect = new UI.TextEntry();
        this.animSelect.ontext = (s: string) => {
            const newNum = Number.parseInt(s);
            if (!Number.isNaN(newNum)) {
                this.modelAnimNum = newNum;
                this.anim = null; // Reset animation when anim number changes
                this.generatedAmap = null;
            }
        }
        const animInputWrap = document.createElement('div');
        animInputWrap.innerHTML = `<label>Animation Number:</label>`;
        animInputWrap.appendChild(this.animSelect.elem); // Fixed typo here
        panel.contents.append(animInputWrap);

        const modelButtonContainer = document.createElement('div');
        modelButtonContainer.style.display = 'flex';
        modelButtonContainer.style.gap = '8px';

        const prevModelButton = document.createElement('button');
        prevModelButton.textContent = 'Previous Valid Model';
        prevModelButton.onclick = async () => {
            prevModelButton.disabled = true;
            await this.destroyCurrentModelResources(this.context.device); // Cleanup before loading
            await this.loadPreviousValidModel();
            prevModelButton.disabled = false;
        };

        const nextModelButton = document.createElement('button');
        nextModelButton.textContent = 'Next Valid Model';
        nextModelButton.onclick = async () => {
            nextModelButton.disabled = true;
            await this.destroyCurrentModelResources(this.context.device); // Cleanup before loading
            await this.loadNextValidModel();
            nextModelButton.disabled = false;
        };

        modelButtonContainer.appendChild(prevModelButton);
        modelButtonContainer.appendChild(nextModelButton);
        panel.contents.append(modelButtonContainer);
// Turntable toggle
const spinBtn = document.createElement('button');
spinBtn.textContent = 'Enable Turntable';
spinBtn.onclick = () => {
    this.turntableEnabled = !this.turntableEnabled;
    spinBtn.textContent = this.turntableEnabled ? 'Disable Turntable' : 'Enable Turntable';
};
panel.contents.append(spinBtn);


const speedWrap = document.createElement('div');
const speedInput = document.createElement('input');
speedInput.type = 'number';
speedInput.step = '0.1';
speedInput.value = this.turntableSpeed.toString();
speedInput.style.width = '100px';
speedWrap.innerHTML = `<label>Spin Speed (rad/s): </label>`;
speedWrap.appendChild(speedInput);
speedInput.onchange = () => {
    const v = Number.parseFloat(speedInput.value);
    if (!Number.isNaN(v)) this.turntableSpeed = v;
};
panel.contents.append(speedWrap);

        const animButtonContainer = document.createElement('div');
        animButtonContainer.style.display = 'flex';
        animButtonContainer.style.gap = '8px';

        const prevAnimButton = document.createElement('button');
        prevAnimButton.textContent = 'Previous Animation';
        prevAnimButton.onclick = async () => {
            prevAnimButton.disabled = true;
            await this.loadPreviousValidAnim();
            prevAnimButton.disabled = false;
        };

        const nextAnimButton = document.createElement('button');
        nextAnimButton.textContent = 'Next Animation';
        nextAnimButton.onclick = async () => {
            nextAnimButton.disabled = true;
            await this.loadNextValidAnim();
            nextAnimButton.disabled = false;
        };

        animButtonContainer.appendChild(prevAnimButton);
        animButtonContainer.appendChild(nextAnimButton);
        panel.contents.append(animButtonContainer);

 
        const bonesSelect = new UI.Checkbox("Display bones", false);
        bonesSelect.onchanged = () => {
            this.displayBones = bonesSelect.checked;
        };
        panel.contents.append(bonesSelect.elem);

        const tPoseCheckbox = new UI.Checkbox("Force T-Pose (Stop Animation)", false); // Starts unchecked
        tPoseCheckbox.onchanged = () => {
            const viewerAnimController = this.animController.animController as any; // Type assertion here
            if (tPoseCheckbox.checked) {
                viewerAnimController.playbackEnabled = false;
                viewerAnimController.currentTimeInFrames = 0; // Reset time to 0 for T-pose
                if (this.modelInst) {
                    this.modelInst.resetPose(); // Explicitly reset model skeleton to T-pose
                }
                this.anim = null; // Clear active animation to ensure it re-fetches if unchecked
                this.modelAnimNum = 0; // Reset animation number for UI display
                if (this.animSelect?.elem instanceof HTMLInputElement) {
                    this.animSelect.elem.value = this.modelAnimNum.toString();
                }
                console.log("Animation stopped and model reset to T-pose.");
            } else {
                // If unchecked, re-enable animation playback.
                // The next update cycle will pick up and apply the animation for the current modelAnimNum.
                viewerAnimController.playbackEnabled = true; // Type assertion here
                console.log("Animation playback re-enabled.");
            }
        };
        panel.contents.insertBefore(tPoseCheckbox.elem, bonesSelect.elem); // Place it before bonesSelect

        
        const useGlobalAnimSelect = new UI.Checkbox("Use global animation number", false);
        useGlobalAnimSelect.onchanged = () => {
            this.useGlobalAnimNum = useGlobalAnimSelect.checked;
        };
        panel.contents.append(useGlobalAnimSelect.elem);

        const autogenAmapSelect = new UI.Checkbox("Autogenerate AMAP", false);
        autogenAmapSelect.onchanged = () => {
            this.autogenAmap = autogenAmapSelect.checked;
            this.generatedAmap = null; // Reset generated AMAP when setting changes
        };
        panel.contents.append(autogenAmapSelect.elem);

        // Removed: Wireframe Mode Toggle for now
        // const wireframeToggle = new UI.Checkbox("Wireframe Mode", this.showWireframe);
        // wireframeToggle.onchanged = () => {
        //     this.showWireframe = wireframeToggle.checked;
        // };
        // panel.contents.append(wireframeToggle.elem);


        return [panel]; // Added return statement
    }

    // New method for resource cleanup
    private async destroyCurrentModelResources(device: GfxDevice) {
        console.log("Destroying and re-initializing resources...");
        // Destroy the current MaterialFactory's cache and any GFX resources it holds
        if (this.materialFactory) {
            this.materialFactory.destroy(device);
        }
        // Re-create a new, clean MaterialFactory with a fresh GfxRenderCache
        this.materialFactory = new MaterialFactory(device);
        this.materialFactory.initialize(); // Re-initialize common textures/factories

        // IMPORTANT: Do NOT re-create texFetcher and modelFetcher here.
        // They are long-lived resources for the scene and should only be created once in createScene.
        // Re-creating them here can lead to redundant fetching and texture issues.

        // Reset all model-related state to force a complete reload
        this.modelInst = undefined; // Force reload of ModelInstance
        this.anim = null;           // Reset current animation
        this.modanim = null;        // Reset modanim data
        this.amap = null;           // Reset amap data
        this.generatedAmap = null;  // Reset generated amap
        this.hasInitializedCamera = false; // Reset camera initialization flag for new model
        //console.log("Model-specific resources reset successfully.");
    }

    public downloadModel() {
        if (this.modelInst !== null && this.modelInst !== undefined) {
downloadBufferSlice(`model_${this.modelNum}${this.modelInst.model.version === ModelVersion.Beta ? '_beta' : ''}.bin`, ArrayBufferSlice.fromView(this.modelInst.model.modelData));
        }
    }

    public setAmapNum(num: number | null) {
        if (num === null) {
            this.amap = null;
        } else {
            this.amap = this.amapColl.getAmap(num);
            if (this.amap) {
                console.log(`Amap ${num} has ${this.amap.byteLength} entries`);
            } else {
                console.warn(`Amap ${num} not found in collection.`);
            }
        }
    }

    private getGlobalAnimNum(modelAnimNum: number): number | undefined {
        if (!this.modanim) {
            console.warn("modanim is not loaded for getGlobalAnimNum. Returning undefined.");
            return undefined;
        }
        if (modelAnimNum * 2 >= this.modanim.byteLength) {
            console.warn(`modelAnimNum ${modelAnimNum} is out of bounds for modanim (byteLength: ${this.modanim.byteLength}). Returning undefined.`);
            return undefined;
        }
        return readUint16(this.modanim, 0, modelAnimNum);
    }

    private getAmapForModelAnim(modelAnimNum: number): DataView | null {
        const printAmap = (amap: DataView) => {
            let s = '';
            for (let i = 0; i < amap.byteLength; i++) {
                s += `${amap.getInt8(i)},`;
            }
            console.log(`Amap: ${s}`);
        };

        if (this.autogenAmap) {
            if (this.generatedAmap === null) {
                let generatedAmap = [0];

                let curCluster = [0];
                while (curCluster.length > 0) {
                    const prevCluster = curCluster;
                    curCluster = [];

                    if (!this.modelInst || !this.modelInst.model || !this.modelInst.model.joints) {
                        console.error("Cannot autogenAmap: modelInst or its joints are not available. Returning null.");
                        return null;
                    }

                    for (let i = 0; i < prevCluster.length; i++) {
                        for (let j = 0; j < this.modelInst.model.joints.length; j++) {
                            const joint = this.modelInst.model.joints[j];
                            if (joint.parent === prevCluster[i]) {
                                curCluster.push(j);
                            }
                        }
                    }

                    for (let i = 0; i < curCluster.length; i++) {
                        generatedAmap.push(curCluster[i]);
                    }
                }

                this.generatedAmap = new DataView(new Int8Array(generatedAmap).buffer);
                printAmap(this.generatedAmap);
            }

            return this.generatedAmap;
        } else {
            if (!this.amap || !this.modelInst || !this.modelInst.model || !this.modelInst.model.joints) {
                console.warn("Amap data or model joints not available for getAmapForModelAnim (autogenAmap is false). Returning null.");
                return null;
            }

            const stride = (((this.modelInst.model.joints.length + 8) / 8)|0) * 8;
            if (modelAnimNum * stride >= this.amap.byteLength) {
                console.warn(`modelAnimNum ${modelAnimNum} * stride ${stride} is out of bounds for amap (byteLength: ${this.amap.byteLength}). Returning null.`);
                return null;
            }

            const amap = dataSubarray(this.amap, modelAnimNum * stride, stride);

            if (this.generatedAmap === null) {
                this.generatedAmap = new DataView(new Int8Array(1).buffer);
                printAmap(amap);
            }

            return amap;
        }
    }

protected override update(viewerInput: Viewer.ViewerRenderInput) {
    super.update(viewerInput);
    this.materialFactory.update(this.animController);

    // --- Turntable advance ---
    if (this.turntableEnabled) {
        this.turntableAngle += viewerInput.deltaTime * this.turntableSpeed;
        // keep angle bounded
        if (this.turntableAngle > Math.PI * 2) this.turntableAngle -= Math.PI * 2;
    }


    }

    protected override addWorldRenderInsts(device: GfxDevice, renderInstManager: GfxRenderInstManager, renderLists: SFARenderLists, sceneCtx: SceneRenderContext) {
        console.log(`Adding world render insts for model ${this.modelNum}. Model instance defined: ${this.modelInst !== undefined && this.modelInst !== null}`);
        if (this.modelInst === undefined) {
            try {
                this.modelAnimNum = 0; // Reset anim when model changes
                this.modanim = this.modanimColl.getModanim(this.modelNum);
                this.amap = this.amapColl.getAmap(this.modelNum);

                if (!this.modanim) {
                    // console.warn(`MODANIM data for model ${this.modelNum} is missing or invalid. Animation might not work.`);
                }
                if (!this.amap && !this.autogenAmap) {
                    // console.warn(`AMAP data for model ${this.modelNum} is missing or invalid. Animation might not work.`);
                }

                const potentialModelInstance = this.modelFetcher.createModelInstance(this.modelNum);

                if (potentialModelInstance instanceof Promise) {
                    potentialModelInstance.then(instance => {
                        this.modelInst = instance;
                        if (this.modelInst) {
                            (this.modelInst as any).modanim = this.modanim;
                            (this.modelInst as any).amap = this.amap;
                        }
                    }).catch(e => {
                        console.error(`Asynchronous model loading failed for ${this.modelNum}:`, e);
                        this.modelInst = null;
                    });
                    return;
                } else {
                    this.modelInst = potentialModelInstance;
                    if (this.modelInst) {
                        (this.modelInst as any).modanim = this.modanim;
                        (this.modelInst as any).amap = this.amap;
                    }
                }
            } catch (e) {
                console.error(`Failed to load model ${this.modelNum} due to synchronous exception:`, e);
                this.modelInst = null;
            }
            return;
        }

        if (this.modelInst === null) {
            return;
        }
        if (this.modelInst === undefined) {
            return;
        }

        // NEW: Adjust camera to frame the model on initial load
        if (!this.hasInitializedCamera) {
            // Using 'as any' to bypass TS error if bbox isn't directly on 'Model' type
            const bbox = (this.modelInst.model as any).bbox; 
            if (bbox) {
                const center = vec3.create();
                vec3.add(center, bbox.min, bbox.max);
                vec3.scale(center, center, 0.5); // (min + max) / 2

                const dimensions = vec3.create();
                vec3.sub(dimensions, bbox.max, bbox.min);

                const maxDim = Math.max(dimensions[0], dimensions[1], dimensions[2]);
                // A common formula to fit an object in view is:
                // distance = (object_size / 2) / Math.tan(fovY / 2)
                // We'll use maxDim for object_size and a multiplier for FOV adjustment.
                const fovFactor = 0.5 * (1 / Math.tan(sceneCtx.viewerInput.camera.fovY / 2));
                const zoomDistance = maxDim * fovFactor;

                const camera = sceneCtx.viewerInput.camera;
                
                // Explicitly set pitch and yaw for a consistent initial viewing angle
                (camera as any).pitch = Math.PI / 8; // Look slightly down (e.g., 22.5 degrees)
                (camera as any).yaw = Math.PI * 0.25; // Look from a quarter turn around (e.g., 45 degrees)

                // Set the camera's target to the center of the model
                (camera as any).target = center;
                // Set the camera's zoom (distance from target)
                (camera as any).zoom = zoomDistance * 1.5; // Multiplier to ensure it's not too tight

                this.hasInitializedCamera = true;
                console.log("Initial camera position set to frame model.");
            } else {
                console.warn(`Model ${this.modelNum} has no bounding box data. Cannot auto-frame camera.`);
            }
        }


// Only attempt animation if playback is enabled AND the model actually has joints.
const animate = (this.animController.animController as any).playbackEnabled;
const canAnimate =
    animate &&
    !!this.modelInst?.model?.joints &&
    this.modelInst.model.joints.length > 0;

if (!canAnimate) {
    // No skeleton or playback disabled → keep pose static and avoid touching anim data.
    if (this.anim !== null && this.modelInst) this.modelInst.resetPose();
    this.anim = null;
} else {
    // Lazy-load the animation once.
    if (this.anim === null) {
        try {
            let globalAnimNum: number | undefined;
            if (this.useGlobalAnimNum) {
                globalAnimNum = this.modelAnimNum;
            } else {
                // If modanim is missing or out of range, getGlobalAnimNum() already returns undefined.
                globalAnimNum = this.getGlobalAnimNum(this.modelAnimNum);
            }

            if (globalAnimNum !== undefined) {
                // This may throw on junk anims → guarded.
                this.anim = this.animColl.getAnim(globalAnimNum);

                // Basic sanity: must have at least one keyframe with poses.
                if (!this.anim?.keyframes?.[0]?.poses) {
                    this.anim = null;
                }
            } else {
                this.anim = null;
            }
        } catch (e) {
            console.warn(`[ANIM_SKIP] getAnim failed: ${(e as Error).message}`);
            this.anim = null;
        }
    }

    if (this.anim !== null) {
        try {
            applyAnimationToModel(
                this.animController.animController.getTimeInSeconds() * 0.60,
                this.modelInst,
                this.anim,
                this.modelAnimNum
            );
        } catch (e) {
            console.warn(`[ANIM_SKIP] applyAnimation failed: ${(e as Error).message}`);
            this.anim = null;
            if (this.modelInst) this.modelInst.resetPose();
        }
    }
}


        const template = renderInstManager.pushTemplateRenderInst();
        fillSceneParamsDataOnTemplate(template, sceneCtx.viewerInput);

        const modelCtx: ModelRenderContext = {
            sceneCtx,
            showDevGeometry: this.displayBones,
            ambienceIdx: 0,
            showMeshes: true,
            outdoorAmbientColor: White, // This sets the global ambient color for the scene
            setupLights: (lights: Light[], typeMask: number) => { // Reinstated and corrected setupLights callback
               // console.log(`setupLights callback invoked for model ${this.modelNum}. Initial lights array length: ${lights.length}`);
                
                // The framework might pre-fill the 'lights' array with objects, some of which might be partially
                // initialized or become stale. We need to ensure that *every* Light object up to a reasonable
                // expected maximum (e.g., 8, based on the initial length log) has its Position and Direction
                // properties explicitly initialized as vec3 instances to prevent "undefined" errors.

                const expectedMaxLights = 8; // Based on observed "Existing lights array length: 8"
                
                for (let i = 0; i < expectedMaxLights; i++) {
                    // Ensure the Light object exists at this index. If not, create a new one.
                    if (!lights[i]) {
                        lights[i] = new Light();
                      //  console.warn(`lights[${i}] was null/undefined, created a new Light object.`);
                    }

                    const currentLight = lights[i];

                    // Crucially, ensure Position and Direction are vec3 instances
                    if (!currentLight.Position) {
                        currentLight.Position = vec3.create();
                     //   console.log(`lights[${i}].Position was undefined, initialized it.`);
                    }
                    if (!currentLight.Direction) {
                        currentLight.Direction = vec3.create();
                       // console.log(`lights[${i}].Direction was undefined, initialized it.`);
                    }

                    // Reset all other properties to a default state before configuring
                    currentLight.Color = colorNewCopy(White); // Fresh color instance
                    vec3.set(currentLight.Position, 0, 0, 0);
                    vec3.set(currentLight.Direction, 0, 0, 0);
                    lightSetDistAttn(currentLight, 0, 0, 0); // Reset attenuation
                    lightSetSpot(currentLight, 0, 0);         // Reset spot
                }

                // Now, configure our primary ambient and directional lights
                // Ambient Light (lights[0])
                const ambientLight = lights[0];
                ambientLight.Color.r *= 0.5; // Slightly dim ambient
                ambientLight.Color.g *= 0.5;
                ambientLight.Color.b *= 0.5;
                ambientLight.Color.a = 1.0; // Ensure full alpha
              //  console.log(`Ambient light configured at lights[0].`);

                // Directional Light (lights[1])
                const dirLight = lights[1];
                dirLight.Color.r = 1.0;
                dirLight.Color.g = 1.0;
                dirLight.Color.b = 1.0;
                dirLight.Color.a = 1.0; // Max brightness
                vec3.set(dirLight.Direction, 0.5, -1.0, 0.5);
                vec3.normalize(dirLight.Direction, dirLight.Direction);
               // console.log(`Directional light configured at lights[1].`);

                // Disable any lights beyond our controlled two by setting their alpha to 0.0
                // This prevents unexpected lighting contributions from stale internal lights.
                for (let i = 2; i < expectedMaxLights; i++) {
                    lights[i].Color.a = 0.0; // Make it completely transparent
                   // console.log(`Disabled light at lights[${i}] (set alpha to 0).`);
                }

                // IMPORTANT: Do NOT change lights.length here if the framework expects a fixed size,
                // as it might still reference elements beyond lights[1]. By setting alpha to 0.0,
                // we effectively disable them without removing them from the array.
               // console.log(`Finished configuring lights. Final lights array length (unchanged): ${lights.length}`);
            },
            mapLights: undefined, 
            cullByAabb: false,
            // Removed: showWireframe: this.showWireframe, // Pass the wireframe toggle state
        };

// Build model matrix (turntable rotation around bbox center when enabled)
const mtx = mat4.create();

if (this.turntableEnabled) {
    // Default center is origin
    const center = vec3.create();

    // If bbox exists, rotate around its center
    const bbox = (this.modelInst?.model as any)?.bbox;
    if (bbox) {
        vec3.add(center, bbox.min, bbox.max);
        vec3.scale(center, center, 0.5);
    }

    // mtx = T(center) * R_y(angle) * T(-center)
    const toOrigin = mat4.create();
    const backToCenter = mat4.create();
    const rotY = mat4.create();

    const negCenter = vec3.fromValues(-center[0], -center[1], -center[2]);
    mat4.fromTranslation(toOrigin, negCenter);
    mat4.fromTranslation(backToCenter, center);
    mat4.fromYRotation(rotY, this.turntableAngle);

    mat4.mul(mtx, rotY, toOrigin);
    mat4.mul(mtx, backToCenter, mtx);
}
        
        // Force shape visibility ON, even if it's private or not typed
        const modelShapes = (this.modelInst as any).modelShapes;
        if (modelShapes && typeof modelShapes.fillMaterialParams === 'function') {
            modelShapes.fillMaterialParams();
        }

        if (modelShapes?.shapes) {
            for (const shapeInstances of modelShapes.shapes) {
                for (const shapeInst of shapeInstances) {
                    (shapeInst as any).visible = true;
                }
            }
        }

        if (this.modelInst) {
            this.modelInst.addRenderInsts(device, renderInstManager, modelCtx, renderLists, mtx);
        }

        renderInstManager.popTemplateRenderInst();

        if (this.displayBones) {
            if (this.modelInst && this.modelInst.model && this.modelInst.skeletonInst) {
                const ctx = getDebugOverlayCanvas2D();
                for (let i = 1; i < this.modelInst.model.joints.length; i++) {
                    const joint = this.modelInst.model.joints[i];
                    const jointMtx = mat4.clone(this.modelInst.skeletonInst.getJointMatrix(i));
                    mat4.mul(jointMtx, jointMtx, mtx);
                    const jointPt = vec3.create();
                    mat4.getTranslation(jointPt, jointMtx);

                    if (joint.parent != 0xff) {
                        const parentMtx = mat4.clone(this.modelInst.skeletonInst.getJointMatrix(joint.parent));
                        mat4.mul(parentMtx, parentMtx, mtx);
                        const parentPt = vec3.create();
                        mat4.getTranslation(parentPt, parentMtx);
                        drawWorldSpaceLine(ctx, sceneCtx.viewerInput.camera.clipFromWorldMatrix, parentPt, jointPt);
                    } else {
                        drawWorldSpacePoint(ctx, sceneCtx.viewerInput.camera.clipFromWorldMatrix, jointPt);
                    }
                }
            }
        }
    }
    
    // Cleanup method for when the entire scene is destroyed (e.g. switching to a different scene desc)
    public override destroy(device: GfxDevice): void {
        super.destroy(device); // Call base class destroy
        if (this.materialFactory) {
            this.materialFactory.destroy(device);
        }
        // Additional cleanup if needed for other persistent resources not managed by materialFactory
        // Note: The comprehensive resource destruction is handled in destroyCurrentModelResources,
        // which is called when changing models within the exhibit.
    }

    private async loadNextValidModel(): Promise<void> {
        const maxTries = 500;
        const startingModel = this.modelNum;
        let candidate = this.modelNum;

        for (let tries = 1; tries <= maxTries; tries++) {
            candidate++;
            if (candidate > 0xFFFF)
                candidate = 1;

            if (candidate === startingModel) {
                break;
            }

            try {
                const inst = this.modelFetcher.createModelInstance(candidate);
                const resolvedInst = inst instanceof Promise ? await inst : inst;

                if (!resolvedInst || !(resolvedInst as any).modelShapes?.shapes?.length) {
                    this.modelInst = null;
                    continue;
                }

                // If a valid model is found, update the state and UI
                this.modelNum = candidate;
                this.modelAnimNum = 0; // Reset animation when model changes

                this.anim = null;
                this.generatedAmap = null;
                this.modanim = this.modanimColl.getModanim(this.modelNum);
                this.amap = this.amapColl.getAmap(this.modelNum);

                this.modelInst = resolvedInst;
                (this.modelInst as any).modanim = this.modanim;
                (this.modelInst as any).amap = this.amap;

                if (this.modelSelect?.elem instanceof HTMLInputElement)
                    this.modelSelect.elem.value = this.modelNum.toString();

                if (this.animSelect?.elem instanceof HTMLInputElement)
                    this.animSelect.elem.value = this.modelAnimNum.toString();

                // If the T-pose checkbox is currently checked, ensure animation remains stopped
                // by explicitly setting playbackEnabled to false.
                const tPoseCheckboxElem = document.querySelector<HTMLInputElement>('input[type="checkbox"][title="Force T-Pose (Stop Animation)"]');
                if (tPoseCheckboxElem && tPoseCheckboxElem.checked) {
                    (this.animController.animController as any).playbackEnabled = false;
                    (this.animController.animController as any).currentTimeInFrames = 0;
                    if (this.modelInst) {
                        this.modelInst.resetPose();
                    }
                    this.anim = null; // Ensure animation is cleared for the new model in T-pose
                } else {
                    // If T-pose checkbox is unchecked, ensure animation is enabled for the new model
                    (this.animController.animController as any).playbackEnabled = true;
                }


                console.log(`Successfully loaded model: ${this.modelNum}`); // Log when model is successfully loaded
                return; // Found and loaded a valid model
            } catch (e) {
                console.warn(`Model ${candidate} threw error during validation:`, e);
                this.modelInst = null; // Mark as failed
            }
        }
        console.warn(`No valid models found after ${maxTries} tries.`);
    }

    private async loadPreviousValidModel(): Promise<void> {
        const maxTries = 500;
        const startingModel = this.modelNum;
        let candidate = this.modelNum;

        for (let tries = 1; tries <= maxTries; tries++) {
            candidate--;
            if (candidate <= 0) candidate = 0xFFFF;

            if (candidate === startingModel) {
                console.warn(`Wrapped back to starting model ${startingModel}. No valid models found.`);
                break;
            }

            try {
                const inst = this.modelFetcher.createModelInstance(candidate);
                const resolvedInst = inst instanceof Promise ? await inst : inst;

                if (!resolvedInst || !(resolvedInst as any).modelShapes?.shapes?.length) {
                    this.modelInst = null;
                    continue;
                }

                // If a valid model is found, update the state and UI
                this.modelNum = candidate;
                this.modelAnimNum = 0; // Reset animation when model changes

                this.anim = null;
                this.generatedAmap = null;
                this.modanim = this.modanimColl.getModanim(this.modelNum);
                this.amap = this.amapColl.getAmap(this.modelNum);

                this.modelInst = resolvedInst;
                (this.modelInst as any).modanim = this.modanim;
                (this.modelInst as any).amap = this.amap;

                if (this.modelSelect?.elem instanceof HTMLInputElement)
                    this.modelSelect.elem.value = this.modelNum.toString();

                if (this.animSelect?.elem instanceof HTMLInputElement)
                    this.animSelect.elem.value = this.modelAnimNum.toString();

                // If the T-pose checkbox is currently checked, ensure animation remains stopped
                const tPoseCheckboxElem = document.querySelector<HTMLInputElement>('input[type="checkbox"][title="Force T-Pose (Stop Animation)"]');
                if (tPoseCheckboxElem && tPoseCheckboxElem.checked) {
                    (this.animController.animController as any).playbackEnabled = false;
                    (this.animController.animController as any).currentTimeInFrames = 0;
                    if (this.modelInst) {
                        this.modelInst.resetPose();
                    }
                    this.anim = null; // Ensure animation is cleared for the new model in T-pose
                } else {
                    // If T-pose checkbox is unchecked, ensure animation is enabled for the new model
                    (this.animController.animController as any).playbackEnabled = true;
                }

                console.log(`Successfully loaded model: ${this.modelNum}`); // Log when model is successfully loaded
                return; // Found and loaded a valid model
            } catch (e) {
                console.warn(`Model ${candidate} threw error during validation:`, e);
            }
        }
        console.warn(`No valid models found after ${maxTries} tries.`);
    }

    private async loadNextValidAnim(): Promise<void> {
        const maxTries = 500;
        const startingAnimNum = this.modelAnimNum;
        let candidateAnimNum = this.modelAnimNum;
        
        console.log(`Searching for next valid animation starting from: ${startingAnimNum}`);

        for (let tries = 1; tries <= maxTries; tries++) {
            candidateAnimNum++;
            // Wrap around if needed, adjust max anim number as per SFA game data
            if (candidateAnimNum > 1000) // Arbitrary large number, adjust if a max is known
                candidateAnimNum = 0;

            if (candidateAnimNum === startingAnimNum && tries > 1) { // Avoid infinite loop if no anims
                console.warn(`Wrapped back to starting animation ${startingAnimNum}. No other valid animations found.`);
                break;
            }

            try {
                let globalAnimNumToFetch: number | undefined = candidateAnimNum;
                if (!this.useGlobalAnimNum) {
                    globalAnimNumToFetch = this.getGlobalAnimNum(candidateAnimNum);
                }

                if (globalAnimNumToFetch !== undefined) {
                    const potentialAnim = this.animColl.getAnim(globalAnimNumToFetch);

                    if (potentialAnim && potentialAnim.keyframes && potentialAnim.keyframes.length > 0 && potentialAnim.keyframes[0] && potentialAnim.keyframes[0].poses) {
                        this.modelAnimNum = candidateAnimNum;
                        this.anim = potentialAnim;
                        this.generatedAmap = null; // Invalidate generated AMAP to force re-evaluation if needed
                        if (this.animSelect?.elem instanceof HTMLInputElement) {
                            this.animSelect.elem.value = this.modelAnimNum.toString();
                        }
                        // If T-pose checkbox is checked, ensure animation remains stopped even after loading new anim
                        const tPoseCheckboxElem = document.querySelector<HTMLInputElement>('input[type="checkbox"][title="Force T-Pose (Stop Animation)"]');
                        if (tPoseCheckboxElem && tPoseCheckboxElem.checked) {
                            (this.animController.animController as any).playbackEnabled = false;
                            (this.animController.animController as any).currentTimeInFrames = 0;
                            if (this.modelInst) {
                                this.modelInst.resetPose();
                            }
                        } else {
                             // If T-pose checkbox is unchecked, ensure animation is enabled for the new anim
                            (this.animController.animController as any).playbackEnabled = true;
                        }

                        console.log(`Successfully loaded animation: ${this.modelAnimNum} (Global: ${globalAnimNumToFetch})`);
                        return; // Found and loaded a valid animation
                    }
                }
            } catch (e) {
                console.warn(`Animation ${candidateAnimNum} threw error during validation:`, e);
            }
        }
        console.warn(`No valid animations found after ${maxTries} tries.`);
    }

    private async loadPreviousValidAnim(): Promise<void> {
        const maxTries = 500;
        const startingAnimNum = this.modelAnimNum;
        let candidateAnimNum = this.modelAnimNum;

        console.log(`Searching for previous valid animation starting from: ${startingAnimNum}`);

        for (let tries = 1; tries <= maxTries; tries++) {
            candidateAnimNum--;
            if (candidateAnimNum < 0)
                candidateAnimNum = 1000; // Arbitrary large number for wrap-around max

            if (candidateAnimNum === startingAnimNum && tries > 1) { // Avoid infinite loop if no anims
                console.warn(`Wrapped back to starting animation ${startingAnimNum}. No other valid animations found.`);
                break;
            }

            try {
                let globalAnimNumToFetch: number | undefined = candidateAnimNum;
                if (!this.useGlobalAnimNum) {
                    globalAnimNumToFetch = this.getGlobalAnimNum(candidateAnimNum);
                }

                if (globalAnimNumToFetch !== undefined) {
                    const potentialAnim = this.animColl.getAnim(globalAnimNumToFetch);

                    if (potentialAnim && potentialAnim.keyframes && potentialAnim.keyframes.length > 0 && potentialAnim.keyframes[0] && potentialAnim.keyframes[0].poses) {
                        this.modelAnimNum = candidateAnimNum;
                        this.anim = potentialAnim;
                        this.generatedAmap = null; // Invalidate generated AMAP to force re-evaluation if needed
                        if (this.animSelect?.elem instanceof HTMLInputElement) {
                            this.animSelect.elem.value = this.modelAnimNum.toString();
                        }
                        // If T-pose checkbox is checked, ensure animation remains stopped even after loading new anim
                        const tPoseCheckboxElem = document.querySelector<HTMLInputElement>('input[type="checkbox"][title="Force T-Pose (Stop Animation)"]');
                        if (tPoseCheckboxElem && tPoseCheckboxElem.checked) {
                            (this.animController.animController as any).playbackEnabled = false;
                            (this.animController.animController as any).currentTimeInFrames = 0;
                            if (this.modelInst) {
                                this.modelInst.resetPose();
                            }
                        } else {
                            // If T-pose checkbox is unchecked, ensure animation is enabled for the new anim
                            (this.animController.animController as any).playbackEnabled = true;
                        }
                        console.log(`Successfully loaded animation: ${this.modelAnimNum} (Global: ${globalAnimNumToFetch})`);
                        return; // Found and loaded a valid animation
                    }
                }
            } catch (e) {
                console.warn(`Animation ${candidateAnimNum} threw error during validation:`, e);
            }
        }
        console.warn(`No valid animations found after ${maxTries} tries.`);
    }
}

export class SFAModelExhibitSceneDesc implements Viewer.SceneDesc {
    constructor(public id: string, public name: string, private modelVersion: ModelVersion, private gameInfo: GameInfo = SFA_GAME_INFO) {
    }

    public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {
        const materialFactory = new MaterialFactory(device);
        materialFactory.initialize();

const animController = new SFAAnimationController();
const modanimColl = await ModanimCollection.create(this.gameInfo, context.dataFetcher);
const amapColl = await AmapCollection.create(this.gameInfo, context.dataFetcher);

const isBeta = this.modelVersion === ModelVersion.Beta;
const isDemo = this.modelVersion === ModelVersion.Demo
const selectedSubdirs = isBeta
    ? ['swapcircle']
    : isDemo
      ? [
       
          'Copy of swaphol',
          'insidegal',
          'linklevel',

        ]
      : [
        
          'animtest',
          'arwing',
          'arwingcity',
          'arwingcloud',
          'arwingdarkice',
          'arwingdragon',
          'arwingtoplanet',
          'bossdrakor',
          'bossgaldon',
          'bosstrex',
          'capeclaw',
          'clouddungeon',
          'cloudrace',
          'crfort',
          'darkicemines',
          'darkicemines2',
          'dbshrine',
          'desert',
          'dfptop',
          'dfshrine',
          'dragrock',
          'dragrockbot',
          'ecshrine',
          'gamefront',
          'gpshrine',
          'greatfox',
          'icemountain',
          'lightfoot',
          'linka',
          'linkb',
          'linkc',
          'linkd',
          'linke',
          'linkf',
          'linkg',
          'linkh',
          'linki',
          'linkj',
          'magiccave',
          'mazecave',
          'mmpass',
          'mmshrine',
          'nwastes',
          'nwshrine',
          'shipbattle',
          'shop',
          'swaphol',
          'swapholbot',
          'volcano',
          'wallcity',
          'warlock',
          'worldmap',
        ];

    
    const texFetcher = await SFATextureFetcher.create(this.gameInfo, context.dataFetcher, this.modelVersion === ModelVersion.Beta);
await texFetcher.loadSubdirs(selectedSubdirs, context.dataFetcher);

const modelFetcher = await ModelFetcher.create(this.gameInfo, Promise.resolve(texFetcher), materialFactory, animController, this.modelVersion);
await modelFetcher.loadSubdirs(selectedSubdirs, context.dataFetcher);

const animColl = await AnimCollection.create(this.gameInfo, context.dataFetcher, selectedSubdirs);

return new ModelExhibitRenderer(context, animController, materialFactory, texFetcher, modelFetcher, animColl, amapColl, modanimColl, this.gameInfo, this.modelVersion);
    }
}
