//% shim=pxt::updateScreen
function updateScreen(img: Image) { }

enum ViewMode {
    //% block="TileMap Mode"
    tilemapView,
    //% block="Raycasting Mode"
    raycastingView,
}

namespace Render {
    const SH = screen.height, SHHalf = SH / 2
    const SW = screen.width, SWHalf = SW / 2
    const fpx = 8
    const fpx_scale = 2 ** fpx
    function tofpx(n: number) { return (n * fpx_scale) | 0 }
    const one = 1 << fpx
    const one2 = 1 << (fpx + fpx)
    const FPX_MAX = (1 << fpx) - 1

    class MotionSet1D {
        p: number
        v: number = 0
        a: number = 0
        constructor(public offset: number) {
            this.p = offset
        }
    }

    export const defaultFov = SW / SH / 2  //Wall just fill screen height when standing 1 tile away

    export class RayCastingRender {
        private tempScreen: Image = image.create(SW, SH)

        velocityAngle: number = 2
        velocity: number = 3
        protected _viewMode = ViewMode.raycastingView
        protected dirXFpx: number
        protected dirYFpx: number
        protected planeX: number
        protected planeY: number
        protected _angle: number
        protected _fov: number
        protected _wallZScale: number = 1
        cameraSway = 0
        protected isWalking = false
        protected cameraOffsetX = 0
        protected cameraOffsetZ_fpx = 0

        //sprites & accessories
        sprSelf: Sprite
        sprites: Sprite[] = []
        sprites2D: Sprite[] = []
        spriteParticles: particles.ParticleSource[] = []
        spriteLikes: SpriteLike[] = []
        spriteAnimations: Animations[] = []
        protected spriteMotionZ: MotionSet1D[] = []
        protected sayRederers: sprites.BaseSpriteSayRenderer[] = []
        protected sayEndTimes: number[] = []

        //reference
        protected tilemapScaleSize = 1 << TileScale.Sixteen
        map: tiles.TileMapData
        bg: Image
        textures: Image[]
        protected oldRender: scene.Renderable
        protected myRender: scene.Renderable

        //render
        protected wallHeightInView: number
        protected wallWidthInView: number
        protected dist: number[] = []
        //render perf const
        cameraRangeAngle: number
        viewZPos: number
        selfXFpx: number
        selfYFpx: number

        //for drawing sprites
        protected invDet: number //required for correct matrix multiplication
        camera: scene.Camera
        tempSprite: Sprite = sprites.create(img`0`)
        protected transformX: number[] = []
        protected transformY: number[] = []
        protected angleSelfToSpr: number[] = []

        onSpriteDirectionUpdateHandler: (spr: Sprite, dir: number) => void

        get xFpx(): number {
            return Fx.add(this.sprSelf._x, Fx.div(this.sprSelf._width, Fx.twoFx8)) as any as number / this.tilemapScaleSize
        }

        // set xFpx(v: number) {
        //     this.sprSelf._x = v * this.tilemapScaleSize as any as Fx8
        // }

        get yFpx(): number {
            return Fx.add(this.sprSelf._y, Fx.div(this.sprSelf._height, Fx.twoFx8)) as any as number / this.tilemapScaleSize
        }

        // set yFpx(v: number) {
        //     this.sprSelf._y = v * this.tilemapScaleSize as any as Fx8
        // }

        get dirX(): number {
            return this.dirXFpx / fpx_scale
        }

        get dirY(): number {
            return this.dirYFpx / fpx_scale
        }

        set dirX(v: number) {
            this.dirXFpx = v * fpx_scale
        }

        set dirY(v: number) {
            this.dirYFpx = v * fpx_scale
        }

        sprXFx8(spr: Sprite) {
            return Fx.add(spr._x, Fx.div(spr._width, Fx.twoFx8)) as any as number / this.tilemapScaleSize
        }

        sprYFx8(spr: Sprite) {
            return Fx.add(spr._y, Fx.div(spr._height, Fx.twoFx8)) as any as number / this.tilemapScaleSize
        }

        get fov(): number {
            return this._fov
        }

        set fov(fov: number) {
            this._fov = fov
            this.wallHeightInView = (SW << (fpx - 1)) / this._fov
            this.wallWidthInView = this.wallHeightInView >> fpx // not fpx  // wallSize / this.fov * 4 / 3 * 2
            this.cameraRangeAngle = Math.atan(this.fov) + .1 //tolerance for spr center just out of camera

            this.setVectors()
        }

        get viewAngle(): number {
            return this._angle
        }
        set viewAngle(angle: number) {
            this._angle = angle
            this.setVectors()
            this.updateSelfImage()
        }

        get wallZScale(): number {
            return this._wallZScale
        }
        set wallZScale(v: number) {
            this._wallZScale = v
        }

        getMotionZ(spr: Sprite, offsetZ: number = 0) {
            let motionZ = this.spriteMotionZ[spr.id]
            if (!motionZ) {
                motionZ = new MotionSet1D(tofpx(offsetZ))
                this.spriteMotionZ[spr.id] = motionZ
            }
            return motionZ
        }

        getZOffset(spr: Sprite) {
            return this.getMotionZ(spr).offset / fpx_scale
        }

        setZOffset(spr: Sprite, offsetZ: number, duration: number = 500) {
            const motionZ = this.getMotionZ(spr, offsetZ)

            motionZ.offset = tofpx(offsetZ)
            if (motionZ.p != motionZ.offset) {
                if (duration === 0)
                    motionZ.p = motionZ.offset
                else if (motionZ.v == 0)
                    this.move(spr, (motionZ.offset - motionZ.p) / fpx_scale * 1000 / duration, 0)
            }
        }

        getMotionZPosition(spr: Sprite) {
            return this.getMotionZ(spr).p / fpx_scale
        }

        //todo, use ZHeight(set from sprite.Height when takeover, then sprite.Height will be replace with width)
        isOverlapZ(sprite1: Sprite, sprite2: Sprite): boolean {
            const p1 = this.getMotionZPosition(sprite1)
            const p2 = this.getMotionZPosition(sprite2)
            if (p1 < p2) {
                if (p1 + sprite1.height > p2) return true
            } else {
                if (p2 + sprite2.height > p1) return true
            }
            return false
        }

        move(spr: Sprite, v: number, a: number) {
            const motionZ = this.getMotionZ(spr)

            motionZ.v = tofpx(v)
            motionZ.a = tofpx(a)
        }

        jump(spr: Sprite, v: number, a: number) {
            const motionZ = this.getMotionZ(spr)
            if (motionZ.p != motionZ.offset)
                return

            motionZ.v = tofpx(v)
            motionZ.a = tofpx(a)
        }

        jumpWithHeightAndDuration(spr: Sprite, height: number, duration: number) {
            const motionZ = this.getMotionZ(spr)
            if (motionZ.p != motionZ.offset)
                return

            // height= -v*v/a/2
            // duration = -v/a*2 *1000
            const v = height * 4000 / duration
            const a = -v * 2000 / duration
            motionZ.v = tofpx(v)
            motionZ.a = tofpx(a)
        }

        get viewMode(): ViewMode {
            return this._viewMode
        }

        set viewMode(v: ViewMode) {
            this._viewMode = v
        }

        updateViewZPos() {
            this.viewZPos = this.spriteMotionZ[this.sprSelf.id].p + (this.sprSelf._height as any as number) - (2 << fpx)
        }

        takeoverSceneSprites() {
            const sc_allSprites = game.currentScene().allSprites
            for (let i = 0; i < sc_allSprites.length;) {
                const spr = sc_allSprites[i]
                if (spr instanceof Sprite) {
                    const sprList = (spr.flags & sprites.Flag.RelativeToCamera) ? this.sprites2D : this.sprites
                    if (sprList.indexOf(spr) < 0) {
                        sprList.push(spr as Sprite)
                        this.getMotionZ(spr, 0)
                        spr.onDestroyed(() => {
                            this.sprites.removeElement(spr as Sprite)   //can be in one of 2 lists
                            this.sprites2D.removeElement(spr as Sprite) //can be in one of 2 lists
                            const sayRenderer = this.sayRederers[spr.id]
                            if (sayRenderer) {
                                this.sayRederers.removeElement(sayRenderer)
                                sayRenderer.destroy()
                            }
                        })
                    }
                } else if (spr instanceof particles.ParticleSource) {
                    const particle = (spr as particles.ParticleSource)
                    if (this.spriteParticles.indexOf(particle) < 0) {
                        this.spriteParticles[(particle.anchor as Sprite).id] = particle
                        particle.anchor = this.tempSprite
                    }
                } else {
                    if (this.spriteLikes.indexOf(spr) < 0)
                        this.spriteLikes.push(spr)
                }
                sc_allSprites.removeElement(spr)
            }
            this.sprites.forEach((spr) => {
                if (spr)
                    this.takeoverSayRenderOfSprite(spr)
            })
        }
        takeoverSayRenderOfSprite(sprite: Sprite) {
            const sprite_as_any = (sprite as any)
            if (sprite_as_any.sayRenderer) {
                this.sayRederers[sprite.id] = sprite_as_any.sayRenderer
                this.sayEndTimes[sprite.id] = sprite_as_any.sayEndTime;
                sprite_as_any.sayRenderer = undefined
                sprite_as_any.sayEndTime = undefined
            }
        }

        tilemapLoaded() {
            const sc = game.currentScene()
            this.map = sc.tileMap.data
            this.textures = sc.tileMap.data.getTileset()
            this.tilemapScaleSize = 1 << sc.tileMap.data.scale
            this.oldRender = sc.tileMap.renderable
            this.spriteLikes.removeElement(this.oldRender)
            sc.allSprites.removeElement(this.oldRender)

            let frameCallback_update = sc.eventContext.registerFrameHandler(scene.PRE_RENDER_UPDATE_PRIORITY + 1, () => {
                const dt = sc.eventContext.deltaTime;
                // sc.camera.update();  // already did in scene
                for (const s of this.sprites)
                    s.__update(sc.camera, dt);
                this.sprSelf.__update(sc.camera, dt)
            })

            let frameCallback_draw = sc.eventContext.registerFrameHandler(scene.RENDER_SPRITES_PRIORITY + 1, () => {
                if (this._viewMode == ViewMode.tilemapView) {
                   // screen.drawImage(sc.background.image, 0, 0)
                    this.oldRender.__drawCore(sc.camera)
                    this.sprites.forEach(spr => spr.__draw(sc.camera))
                    this.sprSelf.__draw(sc.camera)
                } else {
                 //   this.tempScreen.drawImage(sc.background.image, 0, 0)
                    //debug
                    // const ms=control.micros()
                    this.render()
                    // info.setScore(control.micros()-ms)
                    screen.fill(0)
                }
                this.sprites2D.forEach(spr => spr.__draw(sc.camera))
                this.spriteLikes.forEach(spr => spr.__draw(sc.camera))
                if (this._viewMode == ViewMode.raycastingView)
                    this.tempScreen.drawTransparentImage(screen, 0, 0)
            })

            sc.tileMap.addEventListener(tiles.TileMapEvent.Unloaded, data => {
                sc.eventContext.unregisterFrameHandler(frameCallback_update)
                sc.eventContext.unregisterFrameHandler(frameCallback_draw)
            })

            // this.myRender = scene.createRenderable(
            //     scene.TILE_MAP_Z,
            //     (t, c) => this.trace(t, c)
            // )

        }

        constructor() {
            this._angle = 0
            this.fov = defaultFov
            this.camera = new scene.Camera()

            const sc = game.currentScene()
            if (!sc.tileMap) {
                sc.tileMap = new tiles.TileMap();
            } else {
                this.tilemapLoaded()
            }
            game.currentScene().tileMap.addEventListener(tiles.TileMapEvent.Loaded, data => this.tilemapLoaded())

            //self sprite
            this.sprSelf = sprites.create(image.create(this.tilemapScaleSize >> 1, this.tilemapScaleSize >> 1), SpriteKind.Player)
            this.takeoverSceneSprites()
            this.sprites.removeElement(this.sprSelf)
            this.updateViewZPos()
            scene.cameraFollowSprite(this.sprSelf)
            this.updateSelfImage()

            game.onUpdate(function () {
                this.updateControls()
            })

            game.onUpdateInterval(400, () => {
                for (let i = 0; i < this.sprites.length;) {
                    const spr = this.sprites[i]
                    if (spr.flags & sprites.Flag.RelativeToCamera) {
                        this.sprites.removeElement(spr)
                        this.sprites2D.push(spr)
                    } else { i++ }
                }
                for (let i = 0; i < this.sprites2D.length;) {
                    const spr = this.sprites2D[i]
                    if (!(spr.flags & sprites.Flag.RelativeToCamera)) {
                        this.sprites2D.removeElement(spr)
                        this.sprites.push(spr)
                    } else { i++ }
                }
                this.takeoverSceneSprites() // in case some one new
            })


            game.onUpdateInterval(25, () => {
                if (this.cameraSway && this.isWalking) {
                    this.cameraOffsetX = (Math.sin(control.millis() / 150) * this.cameraSway * 3) | 0
                    this.cameraOffsetZ_fpx = tofpx(Math.cos(control.millis() / 75) * this.cameraSway) | 0
                }
            });
            control.__screen.setupUpdate(() => {
                if (this.viewMode == ViewMode.raycastingView)
                    updateScreen(this.tempScreen)
                else
                    updateScreen(screen)
            })

            game.addScenePushHandler((oldScene) => {
                control.__screen.setupUpdate(() => { updateScreen(screen) })
            })
            game.addScenePopHandler((oldScene) => {
                control.__screen.setupUpdate(() => {
                    if (this.viewMode == ViewMode.raycastingView)
                        updateScreen(this.tempScreen)
                    else
                        updateScreen(screen)
                })
            })
        }

        private setVectors() {
            const sin = Math.sin(this._angle)
            const cos = Math.cos(this._angle)
            this.dirXFpx = tofpx(cos)
            this.dirYFpx = tofpx(sin)
            this.planeX = tofpx(sin * this._fov)
            this.planeY = tofpx(cos * -this._fov)
        }

        //todo, pre-drawn dirctional image
        public updateSelfImage() {
            const img = this.sprSelf.image
            img.fill(6)
            const arrowLength = img.width / 2
            img.drawLine(arrowLength, arrowLength, arrowLength + this.dirX * arrowLength, arrowLength + this.dirY * arrowLength, 2)
            img.fillRect(arrowLength - 1, arrowLength - 1, 2, 2, 2)
        }

        updateControls() {
            if (this.velocityAngle !== 0) {
                const dx = controller.dx(this.velocityAngle)
                if (dx) {
                    this.viewAngle += dx
                }
            }
            if (this.velocity !== 0) {
                this.isWalking = true
                const dy = controller.dy(this.velocity)
                if (dy) {
                    const nx = this.xFpx - Math.round(this.dirXFpx * dy)
                    const ny = this.yFpx - Math.round(this.dirYFpx * dy)
                    this.sprSelf.setPosition((nx * this.tilemapScaleSize / fpx_scale), (ny * this.tilemapScaleSize / fpx_scale))
                } else {
                    this.isWalking = false
                }
            }

            for (const spr of this.sprites) {
                this.updateMotionZ(spr)
            }
            this.updateMotionZ(this.sprSelf)
        }

        updateMotionZ(spr: Sprite) {
            const dt = game.eventContext().deltaTime
            const motionZ = this.spriteMotionZ[spr.id]
            //if (!motionZ) continue

            if (motionZ.v != 0 || motionZ.p != motionZ.offset) {
                motionZ.v += motionZ.a * dt, motionZ.p += motionZ.v * dt
                //landing
                if ((motionZ.a >= 0 && motionZ.v > 0 && motionZ.p > motionZ.offset) ||
                    (motionZ.a <= 0 && motionZ.v < 0 && motionZ.p < motionZ.offset)) { motionZ.p = motionZ.offset, motionZ.v = 0 }
                if (spr === this.sprSelf)
                    this.updateViewZPos()
            }

        }


        blitRowBreak(screenX: number, screenUp: number, screenDown: number, source: Image, sourceX: number, sourceYBreak: number) {

            let stepY = (sourceYBreak) / (SHHalf - screenUp )
            let sourceY = sourceYBreak - stepY
            let y = SHHalf -1
            if (screenUp < 0)
                screenUp = 0
            while (y  >= Math.ceil(screenUp)-1) {
                if (sourceY < 0) 
                    sourceY = 0
                const c = source.getPixel(sourceX, sourceY)
                this.tempScreen.setPixel(screenX, y, c)
                y--
                sourceY -= stepY
            }
            // from screen half  going down
            stepY = (source.height - sourceYBreak) / (screenDown - SHHalf)
            sourceY = sourceYBreak 
            y = SHHalf
            if (screenDown > SH)
                screenDown = SH
            while (y < Math.round(screenDown)) {
                const c = source.getPixel(sourceX, sourceY)
                this.tempScreen.setPixel(screenX, y, c)
                y++
                sourceY += stepY
            }

        }
        
        render() {
            // based on https://lodev.org/cgtutor/raycasting.html
            this.selfXFpx = this.xFpx
            this.selfYFpx = this.yFpx

            let drawStart = 0
            let drawHeight = 0
            let lastDist = -1, lastTexX = -1, lastMapX = -1, lastMapY = -1
            this.viewZPos = this.spriteMotionZ[this.sprSelf.id].p + (this.sprSelf._height as any as number) - (2 << fpx) + this.cameraOffsetZ_fpx
            let cameraRangeAngle = Math.atan(this.fov) + .1 //tolerance for spr center just out of camera
            //debug
            // const ms=control.millis()

            


            const tex = this.textures[1]
            let rayDirX0 = this.dirXFpx / fpx_scale + (this.planeX / fpx_scale)
            let rayDirY0 = this.dirYFpx / fpx_scale + (this.planeY / fpx_scale)
            let rayDirX1 = this.dirXFpx / fpx_scale - (this.planeX / fpx_scale)
            let rayDirY1 = this.dirYFpx / fpx_scale - (this.planeY / fpx_scale)
            let fmapX = this.selfXFpx / fpx_scale
            let fmapY = this.selfYFpx / fpx_scale

            const sc = game.currentScene() 
           // background
            const speed = 2 // 2: normal speed
            let backgroundOffset = (this._angle / Math.PI * speed ) % 1  // range -1..1
            if (backgroundOffset < 0) backgroundOffset++  // range 0..1
            backgroundOffset *= SW    // range 0..screenwidth
            
            //floor
            for (let y = 60; y < SH; y++) {
                let p = y - SHHalf
                let posZ = SH * this.viewZPos / this.tilemapScaleSize / fpx_scale
                let rowDistance = posZ / p
                let floorStepX = rowDistance * (rayDirX1 - rayDirX0) / SW
                let floorStepY = rowDistance * (rayDirY1 - rayDirY0) / SW



                let floorX = fmapX + rowDistance * rayDirX0
                let floorY = fmapY + rowDistance * rayDirY0
                for (let x = 0; x < SW; x++) {
                      let cellX = Math.floor(floorX)
                     let cellY = Math.floor(floorY)
                    let tx =  (16 * (floorX - cellX)) & 15
                      let ty = (16 * (floorY - cellY)) & (15)
                    let mapX = Math.round(floorX - 0.5) % 16
                    let mapY = Math.round(floorY - 0.5) % 16
                    let tileType = this.map.getTile(mapX, mapY)
                    let floorTex = this.textures[tileType]
                    floorX += floorStepX
                    floorY += floorStepY
                    let c = floorTex.getPixel(tx, ty)
                    this.tempScreen.setPixel(x, y, c)

                }



            }
            // walls

            for (let x = 0; x < SW; x++) {
                const cameraX: number = one - Math.idiv(((x + this.cameraOffsetX) << fpx) << 1, SW)
                let rayDirX = this.dirXFpx + (this.planeX * cameraX >> fpx)
                let rayDirY = this.dirYFpx + (this.planeY * cameraX >> fpx)

                // avoid division by zero
                if (rayDirX == 0) rayDirX = 1
                if (rayDirY == 0) rayDirY = 1

                let mapX = this.selfXFpx >> fpx
                let mapY = this.selfYFpx >> fpx

                // length of ray from current position to next x or y-side
                let sideDistX = 0, sideDistY = 0

                // length of ray from one x or y-side to next x or y-side
                const deltaDistX = Math.abs(Math.idiv(one2, rayDirX));
                const deltaDistY = Math.abs(Math.idiv(one2, rayDirY));

                let mapStepX = 0, mapStepY = 0

                let sideWallHit = false;

                //calculate step and initial sideDist
                if (rayDirX < 0) {
                    mapStepX = -1;
                    sideDistX = ((this.selfXFpx - (mapX << fpx)) * deltaDistX) >> fpx;
                } else {
                    mapStepX = 1;
                    sideDistX = (((mapX << fpx) + one - this.selfXFpx) * deltaDistX) >> fpx;
                }
                if (rayDirY < 0) {
                    mapStepY = -1;
                    sideDistY = ((this.selfYFpx - (mapY << fpx)) * deltaDistY) >> fpx;
                } else {
                    mapStepY = 1;
                    sideDistY = (((mapY << fpx) + one - this.selfYFpx) * deltaDistY) >> fpx;
                }

                let color = 0

                while (true) {
                    //jump to next map square, OR in x-direction, OR in y-direction
                    if (sideDistX < sideDistY) {
                        sideDistX += deltaDistX;
                        mapX += mapStepX;
                        sideWallHit = false;
                    } else {
                        sideDistY += deltaDistY;
                        mapY += mapStepY;
                        sideWallHit = true;
                    }

                    if (this.map.isOutsideMap(mapX, mapY))
                        break
                    color = this.map.getTile(mapX, mapY)
                    if  (this.map.isWall(mapX, mapY))
                        break; // hit!
                }

                if (this.map.isOutsideMap(mapX, mapY))
                    continue

                let perpWallDist = 0
                let wallX = 0
                if (!sideWallHit) {
                    perpWallDist = Math.idiv(((mapX << fpx) - this.selfXFpx + (1 - mapStepX << fpx - 1)) << fpx, rayDirX)
                    wallX = this.selfYFpx + (perpWallDist * rayDirY >> fpx);
                } else {
                    perpWallDist = Math.idiv(((mapY << fpx) - this.selfYFpx + (1 - mapStepY << fpx - 1)) << fpx, rayDirY)
                    wallX = this.selfXFpx + (perpWallDist * rayDirX >> fpx);
                }
                wallX &= FPX_MAX

                // color = (color - 1) * 2
                // if (sideWallHit) color++

                const tex = this.textures[color]
                if (!tex)
                    continue

                let texX = (wallX * tex.width) >> fpx;
                // if ((!sideWallHit && rayDirX > 0) || (sideWallHit && rayDirY < 0))
                //     texX = tex.width - texX - 1;

                const lineHeight = (this.wallHeightInView / perpWallDist)
                const drawEnd = lineHeight * this.viewZPos / this.tilemapScaleSize / fpx_scale;
                const horizontBreak = 1 - this.viewZPos / this.tilemapScaleSize / fpx_scale;
                if (perpWallDist !== lastDist && (texX !== lastTexX || mapX !== lastMapX || mapY !== lastMapY)) {//neighbor line of tex share same parameters
                     
                    drawStart = drawEnd - lineHeight * (this._wallZScale) ;
                    drawHeight = (Math.ceil(drawEnd) - Math.ceil(drawStart) )
                    drawStart += (SH >> 1)

                    lastDist = perpWallDist
                    lastTexX = texX
                    lastMapX = mapX
                    lastMapY = mapY
                }
                //fix start&end points to avoid regmatic between lines
               

                //if (x < SWHalf)
                //    this.tempScreen.blitRow(x, drawStart, tex, texX, drawHeight)
                //else
                    this.blitRowBreak(x, SHHalf + drawEnd - lineHeight, SHHalf + drawEnd, tex, texX, tex.height * horizontBreak)

                this.dist[x] = perpWallDist

                // background 
                for (let y = 0; y < drawStart; y++ ){
                    let backX = (backgroundOffset + x) % SW
                    let c = sc.background.image.getPixel(backX,y)
                    this.tempScreen.setPixel(x,y,c)
                }
            }
            //debug
            // info.setScore(control.millis()-ms)
           // this.tempScreen.print(backgroundOffset.toString(), 0,0,7 )
           // this.tempScreen.print([Math.roundWithPrecision(this._angle, 3)].join(), 20, 5)

            this.drawSprites()
        }

        drawSprites() {
            //debug
            // let msSprs=control.millis()
            /////////////////// sprites ///////////////////

            //for sprite
            const invDet = one2 / (this.planeX * this.dirYFpx - this.dirXFpx * this.planeY); //required for correct matrix multiplication

            this.sprites
                .filter((spr, i) => {
                    const spriteX = this.sprXFx8(spr) - this.xFpx // this.selfXFpx
                    const spriteY = this.sprYFx8(spr) - this.yFpx // this.selfYFpx
                    this.angleSelfToSpr[spr.id] = Math.atan2(spriteX, spriteY)
                    this.transformX[spr.id] = invDet * (this.dirYFpx * spriteX - this.dirXFpx * spriteY) >> fpx;
                    this.transformY[spr.id] = invDet * (-this.planeY * spriteX + this.planeX * spriteY) >> fpx; //this is actually the depth inside the screen, that what Z is in 3D
                    const angleInCamera = Math.atan2(this.transformX[spr.id] * this.fov, this.transformY[spr.id])
                    return angleInCamera > -this.cameraRangeAngle && angleInCamera < this.cameraRangeAngle //(this.transformY[spr.id] > 0
                }).sort((spr1, spr2) => {   // far to near
                    return (this.transformY[spr2.id] - this.transformY[spr1.id])
                }).forEach((spr, index) => {
                    //debug
                    // this.tempScreen.print([spr.id,Math.roundWithPrecision(angle[spr.id],3)].join(), 0, index * 10 + 10,9)
                    this.drawSprite(spr, index, this.transformX[spr.id], this.transformY[spr.id], this.angleSelfToSpr[spr.id])
                })

            //debug
            // info.setLife(control.millis() - msSprs+1)
             //this.tempScreen.print([Math.roundWithPrecision(this._angle,3)].join(), 20,  0)

        }

        registerOnSpriteDirectionUpdate(handler: (spr: Sprite, dir: number) => void) {
            this.onSpriteDirectionUpdateHandler = handler
        }

        drawSprite(spr: Sprite, index: number, transformX: number, transformY: number, myAngle: number) {
            const spriteScreenX = Math.ceil((SWHalf) * (1 - transformX / transformY)) - this.cameraOffsetX;
            const spriteScreenHalfWidth = Math.idiv((spr._width as any as number) / this.tilemapScaleSize / 2 * this.wallWidthInView, transformY)  //origin: (texSpr.width / 2 << fpx) / transformY / this.fov / 3 * 2 * 4
            const spriteScreenLeft = spriteScreenX - spriteScreenHalfWidth
            const spriteScreenRight = spriteScreenX + spriteScreenHalfWidth

            //calculate drawing range in X direction
            //assume there is one range only
            let blitX = 0, blitWidth = 0
            for (let sprX = 0; sprX < SW; sprX++) {
                if (this.dist[sprX] > transformY) {
                    if (blitWidth == 0)
                        blitX = sprX
                    blitWidth++
                } else if (blitWidth > 0) {
                    if (blitX <= spriteScreenRight && blitX + blitWidth >= spriteScreenLeft)
                        break
                    else
                        blitX = 0, blitWidth = 0;
                }
            }
            // this.tempScreen.print([this.getxFx8(spr), this.getyFx8(spr)].join(), 0,index*10+10)
            const blitXSpr = Math.max(blitX, spriteScreenLeft)
            const blitWidthSpr = Math.min(blitX + blitWidth, spriteScreenRight) - blitXSpr
            if (blitWidthSpr <= 0)
                return

            const lineHeight = Math.idiv(this.wallHeightInView, transformY)
            const drawStart = SHHalf + (lineHeight * ((this.viewZPos - this.spriteMotionZ[spr.id].p - (spr._height as any as number)) / this.tilemapScaleSize) >> fpx)

            //for textures=image[][], abandoned
            //    const texSpr = spr.getTexture(Math.floor(((Math.atan2(spr.vxFx8, spr.vyFx8) - myAngle) / Math.PI / 2 + 2-.25) * spr.textures.length +.5) % spr.textures.length)
            //for deal in user code
            if (this.onSpriteDirectionUpdateHandler)
                this.onSpriteDirectionUpdateHandler(spr, ((Math.atan2(spr._vx as any as number, spr._vy as any as number) - myAngle) / Math.PI / 2 + 2 - .25))
            //for CharacterAnimation ext.
            //     const iTexture = Math.floor(((Math.atan2(spr._vx as any as number, spr._vy as any as number) - myAngle) / Math.PI / 2 + 2 - .25) * 4 + .5) % 4
            //     const characterAniDirs = [Predicate.MovingLeft,Predicate.MovingDown, Predicate.MovingRight, Predicate.MovingUp]
            //     character.setCharacterState(spr, character.rule(characterAniDirs[iTexture]))
            //for this.spriteAnimations
            const texSpr = !this.spriteAnimations[spr.id] ? spr.image : this.spriteAnimations[spr.id].getFrameByDir(((Math.atan2(spr._vx as any as number, spr._vy as any as number) - myAngle) / Math.PI / 2 + 2 - .25))

            const sprTexRatio = texSpr.width / spriteScreenHalfWidth / 2
            helpers.imageBlit(
                this.tempScreen,
                blitXSpr,
                drawStart,
                blitWidthSpr,
                lineHeight * spr.height / this.tilemapScaleSize,
                texSpr,
                (blitXSpr - (spriteScreenX - spriteScreenHalfWidth)) * sprTexRatio
                ,
                0,
                blitWidthSpr * sprTexRatio, texSpr.height, true, false)

            screen.fill(0)
            const fpx_div_transformy = Math.roundWithPrecision(transformY / 4 / fpx_scale, 2)
            const height = (SH / fpx_div_transformy)
            const blitXSaySrc = ((blitX - spriteScreenX) * fpx_div_transformy) + SWHalf
            const blitWidthSaySrc = (blitWidth * fpx_div_transformy)

            //sprite
            // screen.drawImage(texSpr, SWHalf-texSpr.width/2, SHHalf)
            //sayText
            const sayRender = this.sayRederers[spr.id]
            if (sayRender) {
                if (this.sayEndTimes[spr.id] && control.millis() > this.sayEndTimes[spr.id]) {
                    this.sayRederers[spr.id] = undefined
                } else {
                    this.tempSprite.x = SWHalf
                    this.tempSprite.y = SHHalf + 2
                    this.camera.drawOffsetX = 0
                    this.camera.drawOffsetY = 0
                    sayRender.draw(screen, this.camera, this.tempSprite)
                }
            }
            //particle
            const particle = this.spriteParticles[spr.id]
            if (particle) {
                if (particle.lifespan) {
                    //debug
                    // this.tempScreen.print([spr.id].join(), 0,index*10+10)
                    this.tempSprite.x = SWHalf
                    this.tempSprite.y = SHHalf + spr.height
                    this.camera.drawOffsetX = 0//spr.x-SWHalf
                    this.camera.drawOffsetY = 0//spr.y-SH
                    particle.__draw(this.camera)
                } else {
                    this.spriteParticles[spr.id] = undefined
                }
            }
            //update screen for this spr
            // const sayTransformY = 
            if (blitXSaySrc <= 0) { //imageBlit considers negative value as 0
                helpers.imageBlit(
                    this.tempScreen,
                    spriteScreenX - SWHalf / fpx_div_transformy, drawStart - height / 2, (blitWidthSaySrc + blitXSaySrc) / fpx_div_transformy, height,
                    screen,
                    0, 0, blitWidthSaySrc + blitXSaySrc, SH, true, false)
            } else {
                helpers.imageBlit(
                    this.tempScreen,
                    // blitX, drawStart - height / 2 , blitWidth, height,
                    blitX, drawStart - height / 2, blitWidth, height,
                    screen,
                    blitXSaySrc, 0, blitWidthSaySrc, SH,
                    true, false)
            }
        }
    }

    //%fixedinstance
    export const raycastingRender = new Render.RayCastingRender()
}

