        // ── GPU-accelerated audio visualizer, rendered behind the vinyl disk ──
        // Opt-in (off by default, see spotify-visualizer-checkbox in Settings > Spotify
        // Extras). Uses its OWN loopback audio capture, independent from beat-glow.js's
        // capture — the two features can be toggled independently, and keeping the
        // capture/analyser lifecycles separate means neither one's on/off state can
        // accidentally starve the other of audio data. Rendering goes through WebGL
        // (not a 2D canvas) so the actual draw work happens on the GPU; the CPU side
        // only builds small per-frame vertex arrays from the analyser's FFT output.
        let vizCanvas = null;
        let vizGl = null;
        let vizProgram = null;
        let vizPositionBuffer = null;
        let vizColorBuffer = null;
        let vizAttribPosition = -1;
        let vizAttribColor = -1;
        let vizDpr = Math.max(1, window.devicePixelRatio || 1);

        // Second program: a full-quad fragment shader that renders the "Aura" mode
        // (a soft glowing white halo that flows organically around the disk).
        // Distinct from vizProgram above because that one only does flat vertex
        // colors over TRIANGLES/LINE_STRIP/POINTS geometry and has no way to do the
        // per-pixel glow/bloom math this mode needs.
        let vizAuraProgram = null;
        let vizAuraQuadBuffer = null;
        let vizAuraAttribQuadPos = -1;
        let vizAuraUniformTime = null;
        let vizAuraUniformBass = null;
        let vizAuraUniformMid = null;
        let vizAuraUniformTreble = null;
        let vizAuraUniformFade = null;
        let vizAuraTime = 0;

        let vizAudio = { stream: null, context: null, analyser: null, freqData: null, timeData: null, starting: false };
        // See the matching latch in beat-glow.js: once loopback capture fails or the
        // audio device/WebAudio renderer errors out, stop re-opening it. Without this
        // updateVisualizerActiveState() re-attempts capture on every Spotify poll,
        // thrashing the audio service on machines where it's broken until the renderer
        // crashes (STATUS_STACK_BUFFER_OVERRUN). Cleared only by restarting the app.
        let vizAudioUnsupported = false;
        let vizRafId = null;
        let vizIsPlaying = false;
        let vizLastFrameAt = 0;
        let vizParticles = [];
        let vizParticleSpawnAcc = 0;

        // Master intensity (0..1) that every mode multiplies into its amplitude and
        // opacity. Instead of cutting the visual dead when the song stops or switches,
        // vizFadeTarget flips to 0 and the render loop ramps vizFade down over
        // VIZ_FADE_OUT_SEC so the bars/waveform/halo/particles shrink and dim away,
        // only tearing capture + the RAF down once it actually reaches zero. Ramp-in is
        // quicker so a starting/next track feels responsive rather than laggy.
        let vizFade = 0;
        let vizFadeTarget = 0;
        const VIZ_FADE_IN_SEC = 0.35;
        const VIZ_FADE_OUT_SEC = 1.1;
        // On a track switch we briefly force the fade toward 0 (a dip) then release it so
        // it swells back up with the next song. vizLastTrackId detects the switch.
        let vizDipActive = false;
        let vizLastTrackId = null;

        function getVizCanvas() {
            if (!vizCanvas) vizCanvas = document.getElementById('spotify-visualizer-canvas');
            return vizCanvas;
        }

        function compileVizShader(gl, type, source) {
            const shader = gl.createShader(type);
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                console.warn('Visualizer shader compile error', gl.getShaderInfoLog(shader));
                gl.deleteShader(shader);
                return null;
            }
            return shader;
        }

        function initVizGL() {
            const canvas = getVizCanvas();
            if (!canvas || vizGl) return vizGl;
            const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
            if (!gl) return null;

            const vsSource = `
                attribute vec2 aPosition;
                attribute vec4 aColor;
                varying vec4 vColor;
                void main() {
                    gl_Position = vec4(aPosition, 0.0, 1.0);
                    gl_PointSize = 3.5;
                    vColor = aColor;
                }
            `;
            const fsSource = `
                precision mediump float;
                varying vec4 vColor;
                void main() {
                    gl_FragColor = vColor;
                }
            `;
            const vs = compileVizShader(gl, gl.VERTEX_SHADER, vsSource);
            const fs = compileVizShader(gl, gl.FRAGMENT_SHADER, fsSource);
            if (!vs || !fs) return null;

            const program = gl.createProgram();
            gl.attachShader(program, vs);
            gl.attachShader(program, fs);
            gl.linkProgram(program);
            if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
                console.warn('Visualizer program link error', gl.getProgramInfoLog(program));
                return null;
            }

            gl.useProgram(program);
            vizAttribPosition = gl.getAttribLocation(program, 'aPosition');
            vizAttribColor = gl.getAttribLocation(program, 'aColor');
            vizPositionBuffer = gl.createBuffer();
            vizColorBuffer = gl.createBuffer();
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

            vizGl = gl;
            vizProgram = program;

            initVizAuraProgram(gl);
            return gl;
        }

        // "Aura" mode's shader program: a full-screen quad, with all the actual
        // visual work (traveling multi-band waves warping a ring, plus a two-layer
        // glow/bloom falloff) done per-pixel in the fragment shader. Driven by a
        // time value and three audio-energy uniforms (bass/mid/treble each warp the
        // ring at a different angular frequency and speed, so the halo flows
        // organically rather than pulsing as one rigid shape) that the JS side
        // updates once per frame from the frequency analyser.
        function initVizAuraProgram(gl) {
            const vsSource = `
                attribute vec2 aQuadPos;
                varying vec2 vPos;
                void main() {
                    vPos = aQuadPos;
                    gl_Position = vec4(aQuadPos, 0.0, 1.0);
                }
            `;
            const fsSource = `
                precision mediump float;
                varying vec2 vPos;
                uniform float uTime;
                uniform float uBass;
                uniform float uMid;
                uniform float uTreble;
                uniform float uFade;

                void main() {
                    float radius = length(vPos);
                    float angle = atan(vPos.y, vPos.x);

                    float wave = sin(angle * 3.0 - uTime * 0.9) * (0.02 + uBass * 0.05)
                        + sin(angle * 7.0 + uTime * 1.6) * (0.012 + uMid * 0.03)
                        + sin(angle * 13.0 - uTime * 2.4) * (0.006 + uTreble * 0.02);

                    float baseRadius = 0.58 + wave;
                    float thickness = 0.045 + uBass * 0.05;

                    float d = abs(radius - baseRadius);
                    float glow = exp(-(d * d) / (thickness * thickness) * 4.0);

                    float haloThickness = thickness * 3.0;
                    float halo = exp(-(d * d) / (haloThickness * haloThickness) * 4.0) * 0.35;

                    float brightness = clamp(glow + halo, 0.0, 1.0);
                    float alpha = brightness * (0.5 + uBass * 0.4) * uFade;

                    gl_FragColor = vec4(1.0, 1.0, 1.0, alpha);
                }
            `;
            const vs = compileVizShader(gl, gl.VERTEX_SHADER, vsSource);
            const fs = compileVizShader(gl, gl.FRAGMENT_SHADER, fsSource);
            if (!vs || !fs) return;

            const program = gl.createProgram();
            gl.attachShader(program, vs);
            gl.attachShader(program, fs);
            gl.linkProgram(program);
            if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
                console.warn('Visualizer aura program link error', gl.getProgramInfoLog(program));
                return;
            }

            gl.useProgram(program);
            vizAuraAttribQuadPos = gl.getAttribLocation(program, 'aQuadPos');
            vizAuraUniformTime = gl.getUniformLocation(program, 'uTime');
            vizAuraUniformBass = gl.getUniformLocation(program, 'uBass');
            vizAuraUniformMid = gl.getUniformLocation(program, 'uMid');
            vizAuraUniformTreble = gl.getUniformLocation(program, 'uTreble');
            vizAuraUniformFade = gl.getUniformLocation(program, 'uFade');

            vizAuraQuadBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, vizAuraQuadBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
                -1, -1, 1, -1, -1, 1,
                -1, 1, 1, -1, 1, 1
            ]), gl.STATIC_DRAW);

            vizAuraProgram = program;
        }

        function resizeVizCanvasIfNeeded() {
            const canvas = getVizCanvas();
            if (!canvas) return;
            // Re-read devicePixelRatio on every resize, not just once at load — it
            // changes when the window moves to a monitor with different Windows
            // display scaling, and a stale value here left the canvas blurry/clipped
            // until the app was restarted.
            vizDpr = Math.max(1, window.devicePixelRatio || 1);
            const rect = canvas.getBoundingClientRect();
            const w = Math.max(1, Math.round(rect.width * vizDpr));
            const h = Math.max(1, Math.round(rect.height * vizDpr));
            if (canvas.width !== w || canvas.height !== h) {
                canvas.width = w;
                canvas.height = h;
                if (vizGl) vizGl.viewport(0, 0, w, h);
            }
        }

        function vizClear() {
            if (!vizGl) return;
            vizGl.clearColor(0, 0, 0, 0);
            vizGl.clear(vizGl.COLOR_BUFFER_BIT);
        }

        function vizDraw(positions, colors, mode) {
            const gl = vizGl;
            if (!gl || !vizProgram || !positions.length) return;
            gl.useProgram(vizProgram);

            gl.bindBuffer(gl.ARRAY_BUFFER, vizPositionBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
            gl.enableVertexAttribArray(vizAttribPosition);
            gl.vertexAttribPointer(vizAttribPosition, 2, gl.FLOAT, false, 0, 0);

            gl.bindBuffer(gl.ARRAY_BUFFER, vizColorBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, colors, gl.DYNAMIC_DRAW);
            gl.enableVertexAttribArray(vizAttribColor);
            gl.vertexAttribPointer(vizAttribColor, 4, gl.FLOAT, false, 0, 0);

            gl.drawArrays(mode, 0, positions.length / 2);
        }

        // Pushes a quad (two triangles) built from four corner points, all sharing the
        // same alpha (driven by the frequency bin's amplitude for that slice).
        function pushVizQuad(positions, colors, x0, y0, x1, y1, x2, y2, x3, y3, amp) {
            positions.push(x0, y0, x1, y1, x2, y2, x0, y0, x2, y2, x3, y3);
            const a = Math.min(1, 0.22 + amp * 0.85);
            for (let i = 0; i < 6; i++) colors.push(1, 1, 1, a);
        }

        // ── Independent loopback audio capture ──
        // Mirrors the approach in beat-glow.js (the main process auto-approves any
        // getDisplayMedia + loopback-audio request, see main.js), but kept as a fully
        // separate stream/context so Beat Glow and the Visualizer can each be switched
        // on or off without affecting the other's audio pipeline.
        async function ensureVizAudioAnalyser() {
            if (vizAudio.analyser) return true;
            if (vizAudioUnsupported) return false; // errored earlier this session — don't re-spin
            if (vizAudio.starting) return false;
            vizAudio.starting = true;
            try {
                const stream = await navigator.mediaDevices.getDisplayMedia({
                    video: { width: 1, height: 1, frameRate: 1 },
                    audio: true
                });
                stream.getVideoTracks().forEach((t) => t.stop());
                const audioTracks = stream.getAudioTracks();
                if (!audioTracks.length) {
                    stream.getTracks().forEach((t) => t.stop());
                    vizAudio.starting = false;
                    vizAudioUnsupported = true; // no loopback audio device — stop retrying
                    return false;
                }
                const audioContext = new (window.AudioContext || window.webkitAudioContext)();
                const analyser = audioContext.createAnalyser();
                analyser.fftSize = 1024;
                analyser.smoothingTimeConstant = 0.75;
                audioContext.createMediaStreamSource(new MediaStream(audioTracks)).connect(analyser);
                vizAudio.stream = stream;
                vizAudio.context = audioContext;
                vizAudio.analyser = analyser;
                vizAudio.freqData = new Uint8Array(analyser.frequencyBinCount);
                vizAudio.timeData = new Uint8Array(analyser.fftSize);
                vizAudio.starting = false;
                audioTracks[0].addEventListener('ended', stopVizAudioAnalyser);
                // If the audio device / WebAudio renderer errors out mid-stream, latch
                // it off so we fall back to synthetic motion instead of re-opening the
                // failing capture (the pattern that precedes the renderer crash).
                audioContext.onstatechange = () => {
                    if (vizAudio.context !== audioContext) return; // already torn down
                    if (audioContext.state === 'closed' || audioContext.state === 'interrupted') {
                        vizAudioUnsupported = true;
                        stopVizAudioAnalyser();
                    }
                };
                return true;
            } catch (e) {
                console.warn('Visualizer audio capture unavailable', e);
                vizAudio.starting = false;
                vizAudioUnsupported = true; // capture threw — fall back to synthetic motion this session
                return false;
            }
        }

        function stopVizAudioAnalyser() {
            try { vizAudio.stream?.getTracks().forEach((t) => t.stop()); } catch (e) { }
            try { if (vizAudio.context) vizAudio.context.close().catch(() => { }); } catch (e) { }
            vizAudio = { stream: null, context: null, analyser: null, freqData: null, timeData: null, starting: false };
        }

        // ── Render modes ──
        // All modes fall back to a gentle synthetic motion when no live audio data is
        // available yet (capture still starting, or permission unavailable) so the
        // visual never just freezes on a blank frame.

        function renderVizCircularBars() {
            const BARS = 48;
            const analyser = vizAudio.analyser;
            const positions = [];
            const colors = [];
            const innerR = 0.46;
            const maxExtra = 0.55;
            if (analyser) analyser.getByteFrequencyData(vizAudio.freqData);
            for (let i = 0; i < BARS; i++) {
                const angle0 = (i / BARS) * Math.PI * 2;
                const angle1 = ((i + 0.72) / BARS) * Math.PI * 2;
                let amp;
                if (analyser) {
                    const bin = Math.floor((i / BARS) * vizAudio.freqData.length * 0.7);
                    amp = vizAudio.freqData[bin] / 255;
                } else {
                    amp = 0.15 + 0.1 * Math.sin(Date.now() / 400 + i);
                }
                amp *= vizFade; // shrink toward the disk + dim as the fade ramps down
                const outerR = innerR + amp * maxExtra;
                const x0 = Math.cos(angle0), y0 = Math.sin(angle0);
                const x1 = Math.cos(angle1), y1 = Math.sin(angle1);
                pushVizQuad(positions, colors,
                    x0 * innerR, y0 * innerR,
                    x0 * outerR, y0 * outerR,
                    x1 * outerR, y1 * outerR,
                    x1 * innerR, y1 * innerR,
                    amp);
            }
            vizClear();
            vizDraw(new Float32Array(positions), new Float32Array(colors), vizGl.TRIANGLES);
        }

        // Circles the waveform around the disk (same polar mapping as the circular
        // bars mode) instead of drawing it as a flat line across the canvas: each
        // time-domain sample becomes a point on a ring, radius offset by that
        // sample's amplitude, closed into a loop with LINE_LOOP.
        function renderVizWaveform() {
            const analyser = vizAudio.analyser;
            const positions = [];
            const colors = [];
            const n = analyser ? vizAudio.timeData.length : 96;
            const innerR = 0.46;
            const ampScale = 0.4;
            if (analyser) analyser.getByteTimeDomainData(vizAudio.timeData);
            for (let i = 0; i < n; i++) {
                const angle = (i / n) * Math.PI * 2;
                let v;
                if (analyser) v = (vizAudio.timeData[i] - 128) / 128;
                else v = Math.sin(i / 6 + Date.now() / 300) * 0.15;
                const r = Math.max(0.08, innerR + v * ampScale * vizFade);
                positions.push(Math.cos(angle) * r, Math.sin(angle) * r);
                colors.push(1, 1, 1, 0.55 * vizFade);
            }
            vizClear();
            vizDraw(new Float32Array(positions), new Float32Array(colors), vizGl.LINE_LOOP);
        }

        function getVizBassEnergy() {
            if (!vizAudio.analyser) return 0.12 + 0.06 * Math.sin(Date.now() / 500);
            vizAudio.analyser.getByteFrequencyData(vizAudio.freqData);
            let sum = 0;
            const bins = Math.min(12, vizAudio.freqData.length);
            for (let i = 0; i < bins; i++) sum += vizAudio.freqData[i];
            return (sum / bins) / 255;
        }

        function getVizMidEnergy() {
            if (!vizAudio.analyser) return 0.1 + 0.05 * Math.sin(Date.now() / 420);
            vizAudio.analyser.getByteFrequencyData(vizAudio.freqData);
            const n = vizAudio.freqData.length;
            const start = Math.floor(n * 0.15);
            const end = Math.floor(n * 0.4);
            let sum = 0;
            for (let i = start; i < end; i++) sum += vizAudio.freqData[i];
            return (sum / (end - start)) / 255;
        }

        function getVizTrebleEnergy() {
            if (!vizAudio.analyser) return 0.08 + 0.05 * Math.sin(Date.now() / 350);
            vizAudio.analyser.getByteFrequencyData(vizAudio.freqData);
            const n = vizAudio.freqData.length;
            const start = Math.floor(n * 0.4);
            const end = Math.floor(n * 0.7);
            let sum = 0;
            for (let i = start; i < end; i++) sum += vizAudio.freqData[i];
            return (sum / (end - start)) / 255;
        }

        // "Aura" mode: a soft glowing white halo that flows organically around the
        // disk. Bass, mid, and treble each warp the ring's radius at a different
        // angular frequency/speed so the glow drifts and breathes rather than
        // pulsing rigidly, with a two-layer glow/bloom falloff for a soft look.
        function renderVizAura(dt) {
            const gl = vizGl;
            if (!gl || !vizAuraProgram) return;
            vizAuraTime += dt;
            // Scale the energies by the fade so the ring's warp/breathing settles as it
            // dies down; uFade below then fades the halo's opacity out on top of that.
            const bass = getVizBassEnergy() * vizFade;
            const mid = getVizMidEnergy() * vizFade;
            const treble = getVizTrebleEnergy() * vizFade;
            vizClear();
            gl.useProgram(vizAuraProgram);
            gl.bindBuffer(gl.ARRAY_BUFFER, vizAuraQuadBuffer);
            gl.enableVertexAttribArray(vizAuraAttribQuadPos);
            gl.vertexAttribPointer(vizAuraAttribQuadPos, 2, gl.FLOAT, false, 0, 0);
            gl.uniform1f(vizAuraUniformTime, vizAuraTime);
            gl.uniform1f(vizAuraUniformBass, bass);
            gl.uniform1f(vizAuraUniformMid, mid);
            gl.uniform1f(vizAuraUniformTreble, treble);
            gl.uniform1f(vizAuraUniformFade, vizFade);
            gl.drawArrays(gl.TRIANGLES, 0, 6);
        }

        function renderVizParticles(dt) {
            // Spawn rate scales with the fade so, once it starts dying down, fewer (then
            // no) new particles appear while the ones already in flight drift out and die.
            const energy = getVizBassEnergy() * vizFade;
            vizParticleSpawnAcc += energy * dt * 40;
            while (vizParticleSpawnAcc >= 1 && vizParticles.length < 90) {
                vizParticleSpawnAcc -= 1;
                const angle = Math.random() * Math.PI * 2;
                const speed = 0.15 + energy * 0.5 + Math.random() * 0.1;
                vizParticles.push({
                    x: Math.cos(angle) * 0.46,
                    y: Math.sin(angle) * 0.46,
                    vx: Math.cos(angle) * speed,
                    vy: Math.sin(angle) * speed,
                    life: 1
                });
            }
            const positions = [];
            const colors = [];
            for (let i = vizParticles.length - 1; i >= 0; i--) {
                const p = vizParticles[i];
                p.x += p.vx * dt;
                p.y += p.vy * dt;
                p.life -= dt * 0.6;
                if (p.life <= 0 || Math.abs(p.x) > 1.3 || Math.abs(p.y) > 1.3) {
                    vizParticles.splice(i, 1);
                    continue;
                }
                positions.push(p.x, p.y);
                colors.push(1, 1, 1, Math.max(0, p.life) * 0.8 * vizFade);
            }
            vizClear();
            if (positions.length) vizDraw(new Float32Array(positions), new Float32Array(colors), vizGl.POINTS);
            else vizClear();
        }

        function vizFrame(ts) {
            vizRafId = requestAnimationFrame(vizFrame);
            if (!vizGl) return;
            resizeVizCanvasIfNeeded();
            const dt = vizLastFrameAt ? Math.min(0.05, (ts - vizLastFrameAt) / 1000) : 0.016;
            vizLastFrameAt = ts;

            // Ease the master fade toward its target (1 while active, 0 once stopped),
            // ramping in quickly but dying down slowly. A track-switch dip overrides the
            // target down to 0 until the visual has died away, then releases so it swells
            // back up with the new song. Once a real fade-out (playback stopped, not a
            // dip) has fully completed, tear the pipeline down — this is where capture +
            // the RAF actually stop, not the moment playback ended.
            const effectiveTarget = vizDipActive ? 0 : vizFadeTarget;
            const fadeDur = effectiveTarget > vizFade ? VIZ_FADE_IN_SEC : VIZ_FADE_OUT_SEC;
            const fadeStep = dt / fadeDur;
            if (effectiveTarget > vizFade) vizFade = Math.min(effectiveTarget, vizFade + fadeStep);
            else vizFade = Math.max(effectiveTarget, vizFade - fadeStep);
            if (vizFade <= 0.001) {
                if (vizDipActive) {
                    vizDipActive = false; // dip bottomed out — let it swell back to target
                } else if (vizFadeTarget === 0) {
                    teardownViz();
                    return;
                }
            }

            const mode = getVisualizerMode();
            if (mode === 'waveform') renderVizWaveform();
            else if (mode === 'aura') renderVizAura(dt);
            else if (mode === 'particles') renderVizParticles(dt);
            else renderVizCircularBars();
        }

        // Starts/stops capture + the render loop based on (enabled AND currently
        // playing). Both conditions matter: no point spending GPU/CPU time animating
        // an inaudible visual, and no point running loopback capture while paused.
        function updateVisualizerActiveState() {
            const canvas = getVizCanvas();
            const active = isVisualizerEnabled() && vizIsPlaying;

            if (active) {
                vizFadeTarget = 1;
                if (canvas) canvas.classList.add('visualizer-active');
                if (!vizGl) initVizGL();
                ensureVizAudioAnalyser();
                if (!vizRafId) vizRafId = requestAnimationFrame(vizFrame);
            } else {
                // Don't cut the visual dead. Aim the fade at 0 and keep the render loop
                // running so the current mode animates its way down; vizFrame tears the
                // pipeline down once vizFade reaches zero. The CSS .visualizer-active
                // opacity stays on through the fade (teardownViz removes it) so the
                // canvas doesn't blank out from under the dying animation.
                vizFadeTarget = 0;
                // If the loop isn't running there's nothing to animate the fade — tear
                // down straight away (also handles the enabled-off / GL-failed cases).
                if (!vizRafId) teardownViz();
            }
        }

        // Full stop: drop the loopback capture, reset per-mode state, cancel the RAF and
        // clear the canvas. Only called once a fade-out has completed (or when there's no
        // loop to fade), never the instant playback stops.
        function teardownViz() {
            const canvas = getVizCanvas();
            if (canvas) canvas.classList.remove('visualizer-active');
            stopVizAudioAnalyser();
            vizParticles = [];
            vizParticleSpawnAcc = 0;
            vizAuraTime = 0;
            vizLastFrameAt = 0;
            vizFade = 0;
            vizFadeTarget = 0;
            vizDipActive = false;
            if (vizRafId) {
                cancelAnimationFrame(vizRafId);
                vizRafId = null;
            }
            vizClear();
        }

        function updateVisualizerFromPlayback(data) {
            vizIsPlaying = !!(data && data.is_playing);

            // When the track switches (but playback continues), dip the visual down and
            // let it swell back with the new song instead of running seamlessly across
            // the boundary — same "die down, don't cut" feel as a stop, but it recovers.
            const trackId = (data && data.track && data.track.id) || null;
            if (trackId !== vizLastTrackId) {
                // Only dip on an actual change between two real tracks while it's already
                // showing — not the first track appearing or playback going empty (those
                // are handled by the normal fade in/out via updateVisualizerActiveState).
                if (vizLastTrackId && trackId && vizIsPlaying && vizFade > 0.05) {
                    vizDipActive = true;
                }
                vizLastTrackId = trackId;
            }

            updateVisualizerActiveState();
        }

        // Called from settings.js right after the enabled checkbox / mode radios change.
        function applyVisualizerPrefs() {
            updateVisualizerActiveState();
        }
