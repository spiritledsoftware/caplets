import {
  AdditiveBlending,
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  CatmullRomCurve3,
  Color,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  TubeGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";

type ApertureMode = "vanilla" | "progressive" | "code_mode" | "remote";

interface ApertureSceneOptions {
  canvas: HTMLCanvasElement;
  canAnimate: boolean;
  root: HTMLElement;
  stage: HTMLElement;
}

export function initApertureScene({ canvas, canAnimate, root, stage }: ApertureSceneOptions) {
  const renderer = new WebGLRenderer({
    alpha: true,
    antialias: true,
    canvas,
    powerPreference: "low-power",
  });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = SRGBColorSpace;

  const scene = new Scene();
  const camera = new PerspectiveCamera(36, 1, 0.1, 80);
  const styles = window.getComputedStyle(root);
  const sceneHex = (name: string, fallback: number) => {
    const value = styles.getPropertyValue(name).trim();
    return value.startsWith("#") ? Number.parseInt(value.slice(1), 16) : fallback;
  };
  const colors = {
    ash: sceneHex("--aperture-scene-ash", 0xe3d8c0),
    ember: sceneHex("--aperture-scene-ember", 0xe0582f),
    ink: sceneHex("--aperture-scene-ink", 0x1f2018),
    olive: sceneHex("--aperture-scene-olive", 0x686b4e),
    paper: sceneHex("--aperture-scene-paper", 0xfff8ea),
    parchment: sceneHex("--aperture-scene-parchment", 0xf6e8c8),
    signal: sceneHex("--aperture-scene-signal", 0xffd7a8),
  };

  const field = new Group();
  field.rotation.x = -0.08;
  scene.add(field);

  const gridMaterial = new LineBasicMaterial({
    color: colors.ash,
    transparent: true,
    opacity: 0.13,
    depthWrite: false,
  });
  const gridPoints: number[] = [];
  for (let x = -8; x <= 8; x += 1) {
    gridPoints.push(x, -4, -1.2, x, 4, -1.2);
  }
  for (let y = -4; y <= 4; y += 1) {
    gridPoints.push(-8, y, -1.2, 8, y, -1.2);
  }
  const grid = new LineSegments(new BufferGeometry(), gridMaterial);
  grid.geometry.setAttribute("position", new Float32BufferAttribute(gridPoints, 3));
  field.add(grid);

  const routeCurve = new CatmullRomCurve3([
    new Vector3(-6.6, -2.15, 0.45),
    new Vector3(-4.3, -1.15, 0.2),
    new Vector3(-2.1, -0.72, 0.12),
    new Vector3(-0.55, 0.08, 0.35),
    new Vector3(1.15, 0.52, 0.08),
    new Vector3(3.2, 1.08, 0.2),
    new Vector3(5.6, 2.02, 0.46),
  ]);
  const routeSamples = routeCurve.getPoints(64);

  const routeMaterial = new MeshBasicMaterial({
    color: colors.ember,
    transparent: true,
    opacity: 0.74,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  const route = new Mesh(new TubeGeometry(routeCurve, 72, 0.025, 6, false), routeMaterial);
  route.renderOrder = 2;
  field.add(route);

  const routeGlowMaterial = new MeshBasicMaterial({
    color: colors.ember,
    transparent: true,
    opacity: 0.18,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  const routeGlow = new Mesh(new TubeGeometry(routeCurve, 72, 0.14, 8, false), routeGlowMaterial);
  routeGlow.renderOrder = 1;
  field.add(routeGlow);

  const clusterCenters = [
    new Vector2(-5.4, -1.9),
    new Vector2(-3.6, 1.5),
    new Vector2(-1.3, -2.2),
    new Vector2(0.45, 1.1),
    new Vector2(2.1, -1.3),
    new Vector2(4.1, 1.7),
    new Vector2(5.35, -0.55),
  ];

  const fragmentGeometry = new BoxGeometry(1, 0.036, 0.13);
  type Fragment = {
    baseScale: Vector3;
    cluster: number;
    clusterDistance: number;
    mesh: Mesh<BoxGeometry, MeshBasicMaterial>;
    routeDistance: number;
  };
  const fragments: Fragment[] = [];

  const seeded = (seed: number) => {
    const value = Math.sin(seed * 12.9898) * 43758.5453;
    return value - Math.floor(value);
  };

  function routeDistance(point: Vector3) {
    let distance = Number.POSITIVE_INFINITY;
    for (const sample of routeSamples) {
      distance = Math.min(distance, point.distanceTo(sample));
    }
    return distance;
  }

  for (let index = 0; index < 128; index += 1) {
    const x = -7.2 + seeded(index + 1) * 14.4;
    const y = -3.35 + seeded(index + 19) * 6.7;
    const z = -1.05 + seeded(index + 37) * 2.1;
    const material = new MeshBasicMaterial({
      color: colors.ash,
      transparent: true,
      opacity: 0.36,
      depthWrite: false,
    });
    const mesh = new Mesh(fragmentGeometry, material);
    const width = 0.32 + seeded(index + 71) * 0.8;
    mesh.position.set(x, y, z);
    mesh.rotation.set(
      (seeded(index + 8) - 0.5) * 0.22,
      (seeded(index + 17) - 0.5) * 0.32,
      (seeded(index + 29) - 0.5) * 0.72,
    );
    mesh.scale.set(width, 1, 1);

    let cluster = 0;
    let clusterDistance = Number.POSITIVE_INFINITY;
    for (const [clusterIndex, center] of clusterCenters.entries()) {
      const distance = center.distanceTo(new Vector2(x, y));
      if (distance < clusterDistance) {
        cluster = clusterIndex;
        clusterDistance = distance;
      }
    }

    fragments.push({
      baseScale: mesh.scale.clone(),
      cluster,
      clusterDistance,
      mesh,
      routeDistance: routeDistance(mesh.position),
    });
    field.add(mesh);
  }

  function circlePoints(radius = 1) {
    const points: Vector3[] = [];
    for (let step = 0; step <= 72; step += 1) {
      const angle = (step / 72) * Math.PI * 2;
      points.push(new Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius, 0.04));
    }
    return points;
  }

  const mainRingMaterial = new LineBasicMaterial({
    color: colors.signal,
    transparent: true,
    opacity: 0.36,
    depthWrite: false,
  });
  const mainRing = new LineLoop(
    new BufferGeometry().setFromPoints(circlePoints()),
    mainRingMaterial,
  );
  mainRing.renderOrder = 3;
  field.add(mainRing);

  const innerRingMaterial = new LineBasicMaterial({
    color: colors.ember,
    transparent: true,
    opacity: 0.18,
    depthWrite: false,
  });
  const innerRing = new LineLoop(
    new BufferGeometry().setFromPoints(circlePoints()),
    innerRingMaterial,
  );
  innerRing.renderOrder = 3;
  field.add(innerRing);

  const clusterRings = clusterCenters.map((center, index) => {
    const material = new LineBasicMaterial({
      color: index % 2 === 0 ? colors.parchment : colors.ember,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const ring = new LineLoop(new BufferGeometry().setFromPoints(circlePoints()), material);
    ring.position.set(center.x, center.y, 0.08);
    ring.scale.setScalar(0.82 + (index % 3) * 0.13);
    ring.renderOrder = 3;
    field.add(ring);
    return { index, material, ring };
  });

  const signalTextureCanvas = document.createElement("canvas");
  signalTextureCanvas.width = 96;
  signalTextureCanvas.height = 96;
  const signalContext = signalTextureCanvas.getContext("2d");
  if (signalContext) {
    const gradient = signalContext.createRadialGradient(48, 48, 0, 48, 48, 44);
    gradient.addColorStop(0, "rgba(255, 246, 218, 1)");
    gradient.addColorStop(0.23, "rgba(255, 214, 163, 0.92)");
    gradient.addColorStop(0.58, "rgba(224, 88, 47, 0.34)");
    gradient.addColorStop(1, "rgba(224, 88, 47, 0)");
    signalContext.fillStyle = gradient;
    signalContext.fillRect(0, 0, 96, 96);
  }
  const signalTexture = new CanvasTexture(signalTextureCanvas);
  signalTexture.colorSpace = SRGBColorSpace;
  const signalMaterial = new SpriteMaterial({
    map: signalTexture,
    color: colors.signal,
    transparent: true,
    opacity: 0.94,
    depthTest: false,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  const signal = new Sprite(signalMaterial);
  signal.renderOrder = 4;
  field.add(signal);

  const modeTargets = {
    vanilla: {
      cameraZ: 11.2,
      clusterRingOpacity: 0.04,
      fieldTilt: -0.04,
      gridOpacity: 0.2,
      innerRingOpacity: 0.08,
      mainRingOpacity: 0.12,
      mainRingScale: 5.8,
      routeGlowOpacity: 0.04,
      routeOpacity: 0.14,
      signalOpacity: 0.24,
      signalSpeed: 0.00005,
    },
    progressive: {
      cameraZ: 9.6,
      clusterRingOpacity: 0.54,
      fieldTilt: -0.08,
      gridOpacity: 0.15,
      innerRingOpacity: 0.14,
      mainRingOpacity: 0.28,
      mainRingScale: 3.4,
      routeGlowOpacity: 0.12,
      routeOpacity: 0.42,
      signalOpacity: 0.66,
      signalSpeed: 0.00019,
    },
    code_mode: {
      cameraZ: 8.2,
      clusterRingOpacity: 0.06,
      fieldTilt: -0.12,
      gridOpacity: 0.09,
      innerRingOpacity: 0.34,
      mainRingOpacity: 0.58,
      mainRingScale: 1.34,
      routeGlowOpacity: 0.28,
      routeOpacity: 0.88,
      signalOpacity: 1,
      signalSpeed: 0.00062,
    },
    remote: {
      cameraZ: 8.8,
      clusterRingOpacity: 0.16,
      fieldTilt: -0.1,
      gridOpacity: 0.1,
      innerRingOpacity: 0.28,
      mainRingOpacity: 0.48,
      mainRingScale: 2.18,
      routeGlowOpacity: 0.34,
      routeOpacity: 0.92,
      signalOpacity: 0.95,
      signalSpeed: 0.00048,
    },
  } satisfies Record<ApertureMode, Record<string, number>>;

  const colorForFragment = (fragment: Fragment, mode: ApertureMode) => {
    if ((mode === "code_mode" || mode === "remote") && fragment.routeDistance < 0.55)
      return colors.ember;
    if (mode === "progressive" && fragment.clusterDistance < 0.92) {
      return fragment.cluster % 2 === 0 ? colors.parchment : colors.signal;
    }
    return mode === "vanilla" ? colors.olive : colors.ash;
  };

  const opacityForFragment = (fragment: Fragment, mode: ApertureMode) => {
    if (mode === "vanilla")
      return 0.24 + Math.max(0, 1.25 - Math.abs(fragment.mesh.position.z)) * 0.22;
    if (mode === "progressive") {
      if (fragment.clusterDistance < 0.92) return 0.74;
      if (fragment.routeDistance < 0.7) return 0.46;
      return 0.08;
    }
    if (mode === "remote") return fragment.routeDistance < 0.72 ? 0.78 : 0.055;
    return fragment.routeDistance < 0.55 ? 0.86 : 0.035;
  };

  const scaleForFragment = (fragment: Fragment, mode: ApertureMode) => {
    if (mode === "vanilla") return 1;
    if (mode === "progressive") return fragment.clusterDistance < 0.92 ? 1.05 : 0.62;
    if (mode === "remote") return fragment.routeDistance < 0.72 ? 1.08 : 0.42;
    return fragment.routeDistance < 0.55 ? 1.16 : 0.38;
  };

  let activeMode = (root.dataset.apertureMode ?? "code_mode") as ApertureMode;
  let targetMode = activeMode;
  let isHeroCycleActive = false;
  const heroCycleStartedAt = performance.now();
  const heroCycleModes = ["vanilla", "progressive", "code_mode"] as const;
  const heroCycleIntervalMs = 2600;
  let signalProgress = 0.36;
  const targetCamera = new Vector3(0, 0, modeTargets[activeMode].cameraZ);
  const targetColor = new Color();
  const targetScale = new Vector3();
  camera.position.copy(targetCamera);
  camera.lookAt(0, 0, 0);
  mainRing.scale.setScalar(modeTargets[activeMode].mainRingScale);
  innerRing.scale.setScalar(modeTargets[activeMode].mainRingScale * 0.62);

  const resizeAperture = () => {
    const rect = stage.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    const pixelRatioCap = width >= 960 ? 1.25 : 1;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelRatioCap));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    field.position.x = width >= 960 ? 2.25 : width >= 720 ? 1.1 : 0;
  };

  const resizeObserver = new ResizeObserver(resizeAperture);
  resizeObserver.observe(stage);
  resizeAperture();

  function setSceneMode(mode: string) {
    if (mode === "vanilla" || mode === "progressive" || mode === "code_mode" || mode === "remote") {
      targetMode = mode;
      root.dataset.apertureMode = mode;
    }
  }

  function paintScene(delta = 1) {
    if (isHeroCycleActive) {
      const cycleIndex =
        Math.floor((performance.now() - heroCycleStartedAt) / heroCycleIntervalMs) %
        heroCycleModes.length;
      setSceneMode(heroCycleModes[cycleIndex]);
    }

    activeMode = targetMode;
    const target = modeTargets[targetMode];
    const easing = canAnimate ? Math.min(0.1 + delta * 0.002, 0.24) : 1;

    targetCamera.set(
      targetMode === "remote" ? 0.6 : 0,
      targetMode === "code_mode" ? 0.1 : 0,
      target.cameraZ,
    );
    camera.position.lerp(targetCamera, easing);
    camera.lookAt(0, 0, 0);

    field.rotation.x += (target.fieldTilt - field.rotation.x) * easing;
    field.rotation.z = canAnimate ? Math.sin(Date.now() * 0.00022) * 0.012 : 0;
    gridMaterial.opacity += (target.gridOpacity - gridMaterial.opacity) * easing;
    routeMaterial.opacity += (target.routeOpacity - routeMaterial.opacity) * easing;
    routeGlowMaterial.opacity += (target.routeGlowOpacity - routeGlowMaterial.opacity) * easing;
    mainRingMaterial.opacity += (target.mainRingOpacity - mainRingMaterial.opacity) * easing;
    innerRingMaterial.opacity += (target.innerRingOpacity - innerRingMaterial.opacity) * easing;
    const nextRingScale = target.mainRingScale;
    mainRing.scale.lerp(targetScale.set(nextRingScale, nextRingScale, 1), easing);
    innerRing.scale.lerp(targetScale.set(nextRingScale * 0.62, nextRingScale * 0.62, 1), easing);

    for (const fragment of fragments) {
      const opacity = opacityForFragment(fragment, targetMode);
      const scale = scaleForFragment(fragment, targetMode);
      fragment.mesh.material.opacity += (opacity - fragment.mesh.material.opacity) * easing;
      fragment.mesh.material.color.lerp(
        targetColor.setHex(colorForFragment(fragment, targetMode)),
        easing,
      );
      fragment.mesh.scale.lerp(
        targetScale.set(fragment.baseScale.x * scale, 1, fragment.baseScale.z),
        easing,
      );
    }

    for (const clusterRing of clusterRings) {
      const pulse = canAnimate
        ? 0.76 + Math.sin(Date.now() * 0.0017 + clusterRing.index * 0.7) * 0.24
        : 1;
      clusterRing.material.opacity +=
        (target.clusterRingOpacity * pulse - clusterRing.material.opacity) * easing;
      const ringScale = 0.82 + (clusterRing.index % 3) * 0.13;
      clusterRing.ring.scale.setScalar(
        ringScale * (targetMode === "progressive" ? 1 + (1 - pulse) * 0.1 : 1),
      );
    }

    if (canAnimate) signalProgress = (signalProgress + delta * target.signalSpeed) % 1;
    const signalPoint = routeCurve.getPoint(signalProgress);
    signal.position.copy(signalPoint);
    signal.position.z += 0.14;
    signalMaterial.opacity += (target.signalOpacity - signalMaterial.opacity) * easing;
    signal.scale.setScalar(0.34 + target.signalOpacity * 0.2);

    renderer.render(scene, camera);
  }

  let lastFrame = performance.now();
  let animationFrame: number | null = null;
  let inView = true;

  const animateAperture = (now: number) => {
    animationFrame = null;
    const delta = now - lastFrame;
    lastFrame = now;
    paintScene(delta);
    if (canAnimate && inView && !document.hidden) {
      startApertureRender();
    }
  };

  const startApertureRender = () => {
    if (animationFrame !== null) return;
    animationFrame = window.requestAnimationFrame(animateAperture);
  };

  const stopApertureRender = () => {
    if (animationFrame === null) return;
    window.cancelAnimationFrame(animationFrame);
    animationFrame = null;
  };

  const updateScrollMode = () => {
    const anchor = window.scrollY + window.innerHeight * 0.46;
    const whySection = document.getElementById("why");
    const setupSection = document.getElementById("install");
    const benchmarkSection = document.getElementById("proof");

    if (!whySection || anchor < whySection.offsetTop) {
      isHeroCycleActive = true;
      startApertureRender();
      return;
    }

    isHeroCycleActive = false;
    let nextMode: ApertureMode = "vanilla";
    if (benchmarkSection && benchmarkSection.offsetTop <= anchor) nextMode = "code_mode";
    else if (setupSection && setupSection.offsetTop <= anchor) nextMode = "progressive";
    setSceneMode(nextMode);
    startApertureRender();
  };
  let scrollModeFrame: number | null = null;
  const requestScrollModeUpdate = () => {
    if (scrollModeFrame !== null) return;
    scrollModeFrame = window.requestAnimationFrame(() => {
      scrollModeFrame = null;
      updateScrollMode();
    });
  };

  const visibilityObserver = new IntersectionObserver(
    ([entry]) => {
      inView = Boolean(entry?.isIntersecting);
      if (inView) {
        startApertureRender();
      } else {
        stopApertureRender();
      }
    },
    { threshold: 0.05 },
  );
  visibilityObserver.observe(root);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopApertureRender();
    } else {
      startApertureRender();
    }
  });

  root.classList.add("is-aperture-ready");
  setSceneMode(activeMode);
  updateScrollMode();
  window.addEventListener("scroll", requestScrollModeUpdate, { passive: true });
  window.addEventListener("resize", requestScrollModeUpdate);
  paintScene(1);
  startApertureRender();
}
