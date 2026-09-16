import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { RoundedBox, Text } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { Group, CanvasTexture } from 'three';
import { interactionBus } from './interactions';
import type { WallCollider } from './Player';
import { useGameState, POLYCLINIC_BED_INDEX } from '../../game/store';
import { CLINIC_LABELS } from '../../game/clinic';
import { FloatingVoicePanel } from './FloatingVoicePanel';
import { StylizedCharacter } from './StylizedCharacter';
import { parentGenderForId } from '../../voice/patientPersona';

// ───────── World layout — a doctor's private office (muayenehane) ─────────
//
// No exam bed. The patient walks in, sits on a patient chair across from
// the desk, talks to the (seated) doctor, then walks out.
//
//            z = −10 ┌─────────────────────────┐       BACK WALL (diplomas)
//                    │                          │
//                    │   [bookshelf]   [plant]  │
//                    │                          │
//                    │      ┌───────────┐       │   doctor's desk (wide)
//                    │      │   DESK    │       │   doctor sits behind it
//                    │      └───────────┘       │
//                    │                          │
//                    │       [patient chair]    │   patient sits facing doc
//                    │                          │
//            z = −2  ├──────── ⌐ ──────────────┤       door (into corridor)
//                    │                          │
//                    │        CORRIDOR          │
//                    │                          │
//            z = +8  └──────────────────────────┘       player spawn / entry
//                    x = −6                  x = +6

const ROOM_BACK_Z = -10;
const ROOM_FRONT_Z = -2;
const CORRIDOR_FRONT_Z = 8;
const WORLD_BACK_Z = ROOM_BACK_Z;
const WORLD_LEFT_X = -4.5;
const WORLD_RIGHT_X = 4.5;
const DOOR_HALF_WIDTH = 0.9;
const DOOR_X = 0;

/** Doctor's desk — centered against the back wall, facing south. */
const DESK_POS: [number, number, number] = [0, 0, ROOM_BACK_Z + 1.5];
/** Doctor sits behind the desk (closer to the back wall). */
export const DOCTOR_CHAIR_POS: [number, number, number] = [0, 0, ROOM_BACK_Z + 0.55];
/** Patient chair sits across the desk from the doctor. This is also the
 *  interactable anchor — E / T are triggered near this position. */
export const PATIENT_CHAIR_POS: [number, number, number] = [0, 0, ROOM_BACK_Z + 4.5];
/** Where the walking patient NPC starts (corridor side of the door) and
 *  where they end up (in the patient chair). */
const PATIENT_SPAWN: [number, number, number] = [DOOR_X, 0, ROOM_FRONT_Z + 4];
const PATIENT_AT_SEAT: [number, number, number] = [PATIENT_CHAIR_POS[0], 0, PATIENT_CHAIR_POS[2]];

const OUTER_DEPTH = CORRIDOR_FRONT_Z - WORLD_BACK_Z;
const OUTER_CENTER_Z = (CORRIDOR_FRONT_Z + WORLD_BACK_Z) / 2;
const OUTER_WIDTH = WORLD_RIGHT_X - WORLD_LEFT_X;
const OUTER_CENTER_X = (WORLD_LEFT_X + WORLD_RIGHT_X) / 2;

const PALETTE = {
  skin: '#e4b896',
  sheet: '#f5f1e8',
  hair: '#3a2a1f',
  scrubsDoc: '#5e8ba3',
  patientTop: '#b8a890',
  patientPants: '#4a4035',
  floor: '#d0a878',
  floorPlank: '#c19565',
  floorSeam: '#6a4a32',
  wall: '#f4ecd8',
  wallLow: '#d4b28a',
  wallTrim: '#f7ecd4',
  ceiling: '#fbf3dd',
  ceilingTrim: '#e8d4ac',
  trim: '#c89060',
  accent: '#d65d2f',
  wood: '#9a7648',
  woodDark: '#563a20',
  leather: '#3a2820',
  plant: '#486b3a',
  pot: '#8a5a32',
  paper: '#fbf7ec',
  brass: '#c89a54',
  rugRed: '#8a3628',
};

const FRONT_WALL_SEGMENTS = [
  {
    center: (WORLD_LEFT_X + (DOOR_X - DOOR_HALF_WIDTH)) / 2,
    length: (DOOR_X - DOOR_HALF_WIDTH) - WORLD_LEFT_X,
  },
  {
    center: ((DOOR_X + DOOR_HALF_WIDTH) + WORLD_RIGHT_X) / 2,
    length: WORLD_RIGHT_X - (DOOR_X + DOOR_HALF_WIDTH),
  },
];

// ───────── Left-wall window opening ─────────
//
// The muayenehane window sits on the left wall roughly level with the
// patient's upper torso. To make it actually LOOK like you can see out
// of it, we render the wall as four boxes around the opening instead of
// one solid box, and place a painted sky/skyline backdrop behind the
// hole. The collider for the left wall stays as a single slab so the
// player still can't moonwalk through the glass.
const WINDOW_CENTER_Z = ROOM_BACK_Z + 3.0;
const WINDOW_CENTER_Y = 1.6;
const WINDOW_HALF_W = 0.85; // along world z (frame is rotated π/2 on Y)
const WINDOW_HALF_H = 0.95;
const WINDOW_Z_MIN = WINDOW_CENTER_Z - WINDOW_HALF_W;
const WINDOW_Z_MAX = WINDOW_CENTER_Z + WINDOW_HALF_W;
const WINDOW_Y_MIN = WINDOW_CENTER_Y - WINDOW_HALF_H;
const WINDOW_Y_MAX = WINDOW_CENTER_Y + WINDOW_HALF_H;

export const POLYCLINIC_COLLIDERS: WallCollider[] = [
  // Outer walls
  { x: OUTER_CENTER_X, z: WORLD_BACK_Z - 0.15, w: OUTER_WIDTH, d: 0.3 },
  { x: OUTER_CENTER_X, z: CORRIDOR_FRONT_Z + 0.15, w: OUTER_WIDTH, d: 0.3 },
  { x: WORLD_LEFT_X - 0.15, z: OUTER_CENTER_Z, w: 0.3, d: OUTER_DEPTH },
  { x: WORLD_RIGHT_X + 0.15, z: OUTER_CENTER_Z, w: 0.3, d: OUTER_DEPTH },
  // Exam-room front wall segments (flank the door)
  ...FRONT_WALL_SEGMENTS.map((seg) => ({
    x: seg.center, z: ROOM_FRONT_Z - 0.15, w: seg.length, d: 0.3,
  })),
  // Furniture colliders
  { x: DESK_POS[0], z: DESK_POS[2], w: 2.6, d: 1.0 },
  { x: PATIENT_CHAIR_POS[0], z: PATIENT_CHAIR_POS[2], w: 0.9, d: 0.9 },
  // Bookshelf on the left
  { x: WORLD_LEFT_X + 0.6, z: ROOM_BACK_Z + 1.2, w: 1.1, d: 0.5 },
  // Examination couch — pushed flush against the right wall; long axis along
  // world-z (parallel to the wall) so rotation is 0.
  { x: WORLD_RIGHT_X - 0.55, z: ROOM_BACK_Z + 5.0, w: 0.8, d: 1.9 },
  // Front corners: skeleton (left) + coat rack (right)
  { x: WORLD_LEFT_X + 0.7, z: ROOM_FRONT_Z - 0.6, w: 0.6, d: 0.6 },
  { x: WORLD_RIGHT_X - 0.75, z: ROOM_FRONT_Z - 0.6, w: 0.6, d: 0.6 },
];

// ───────── Helpers ─────────

function Floor() {
  // Parquet planks running along z. Alternating tones + dark seams give the
  // floor real depth rather than a single flat plane.
  const PLANK_WIDTH = 0.45;
  const plankCount = Math.ceil(OUTER_WIDTH / PLANK_WIDTH);
  const planks: JSX.Element[] = [];
  for (let i = 0; i < plankCount; i++) {
    const x = WORLD_LEFT_X + (i + 0.5) * PLANK_WIDTH;
    const shade = i % 3;
    const color = shade === 0 ? PALETTE.floor : shade === 1 ? PALETTE.floorPlank : '#c29460';
    planks.push(
      <mesh
        key={`plank-${i}`}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[x, 0.002, OUTER_CENTER_Z]}
        receiveShadow
      >
        <planeGeometry args={[PLANK_WIDTH * 0.94, OUTER_DEPTH]} />
        <meshStandardMaterial color={color} roughness={0.82} />
      </mesh>
    );
  }
  // Short perpendicular seams every ~2.2m so planks read as individual boards
  const SEAM_STEP = 2.2;
  const seams: JSX.Element[] = [];
  let seamId = 0;
  for (let i = 0; i < plankCount; i++) {
    const x = WORLD_LEFT_X + (i + 0.5) * PLANK_WIDTH;
    const offset = (i % 2) * (SEAM_STEP * 0.5);
    for (let z = WORLD_BACK_Z + offset; z < CORRIDOR_FRONT_Z; z += SEAM_STEP) {
      seams.push(
        <mesh
          key={`seam-${seamId++}`}
          rotation={[-Math.PI / 2, 0, 0]}
          position={[x, 0.004, z]}
        >
          <planeGeometry args={[PLANK_WIDTH * 0.94, 0.025]} />
          <meshStandardMaterial color={PALETTE.floorSeam} roughness={0.95} />
        </mesh>
      );
    }
  }
  return (
    <>
      {/* base layer — catches shadows even if planks don't cover every pixel */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow position={[OUTER_CENTER_X, 0, OUTER_CENTER_Z]}>
        <planeGeometry args={[OUTER_WIDTH, OUTER_DEPTH]} />
        <meshStandardMaterial color={PALETTE.floorSeam} roughness={0.95} />
      </mesh>
      {planks}
      {seams}
    </>
  );
}

function Wall({ position, args, color = PALETTE.wall }: { position: [number, number, number]; args: [number, number, number]; color?: string }) {
  return (
    <mesh position={position} receiveShadow castShadow>
      <boxGeometry args={args} />
      <meshStandardMaterial color={color} roughness={0.9} />
    </mesh>
  );
}

/** Wainscot (lower wall panel) + chair-rail trim + crown molding at the ceiling,
 *  rendered as a thin veneer in front of the existing wall. Provides the
 *  classic "muayenehane" two-tone wall without changing collider geometry. */
function WallTrim({
  span,
  axis,
  atCoord,
  flip = false,
}: {
  span: [number, number]; // [start, end] along the wall's axis
  axis: 'x' | 'z'; // wall runs along this axis
  atCoord: number; // the other coordinate where the wall sits
  flip?: boolean; // which side the veneer faces
}) {
  const WAINSCOT_H = 1.0;
  const WAINSCOT_Y = WAINSCOT_H / 2;
  const CHAIR_RAIL_Y = WAINSCOT_H + 0.02;
  // Crown molding hugs the ceiling (ceiling is at y=3.0, crown height 0.12
  // → center at y=2.94, top exactly at the ceiling).
  const CROWN_Y = 2.94;
  const length = Math.abs(span[1] - span[0]);
  const center = (span[0] + span[1]) / 2;
  const thickness = 0.02;
  const offset = flip ? -0.16 : 0.16;
  const pos = (y: number, t: number): [number, number, number] =>
    axis === 'x' ? [center, y, atCoord + t] : [atCoord + t, y, center];
  const size = (h: number, d: number): [number, number, number] =>
    axis === 'x' ? [length, h, d] : [d, h, length];
  return (
    <group>
      {/* wainscot panel (warmer, darker lower third) */}
      <mesh position={pos(WAINSCOT_Y, offset)} receiveShadow>
        <boxGeometry args={size(WAINSCOT_H, thickness)} />
        <meshStandardMaterial color={PALETTE.wallLow} roughness={0.85} />
      </mesh>
      {/* chair-rail — horizontal trim between wainscot and wallpaper */}
      <mesh position={pos(CHAIR_RAIL_Y, offset)} castShadow>
        <boxGeometry args={size(0.06, thickness * 2.5)} />
        <meshStandardMaterial color={PALETTE.wallTrim} roughness={0.6} />
      </mesh>
      {/* crown molding — cornice at the ceiling */}
      <mesh position={pos(CROWN_Y, offset)} castShadow>
        <boxGeometry args={size(0.12, thickness * 3)} />
        <meshStandardMaterial color={PALETTE.wallTrim} roughness={0.55} />
      </mesh>
      {/* baseboard at floor level */}
      <mesh position={pos(0.08, offset)} receiveShadow>
        <boxGeometry args={size(0.16, thickness * 3)} />
        <meshStandardMaterial color={PALETTE.woodDark} roughness={0.6} />
      </mesh>
    </group>
  );
}

function FloorStripe({ zStart, zEnd, x, color }: { zStart: number; zEnd: number; x: number; color: string }) {
  const count = Math.max(1, Math.round(Math.abs(zEnd - zStart) / 1.5));
  const stripes = [];
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count;
    const z = zStart + (zEnd - zStart) * t;
    stripes.push(
      <mesh key={i} rotation={[-Math.PI / 2, 0, 0]} position={[x, 0.03, z]}>
        <planeGeometry args={[0.5, 0.12]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.4} opacity={0.8} transparent />
      </mesh>
    );
  }
  return <>{stripes}</>;
}

/** Padded armchair for the patient. Rotated so the sitter faces the desk.
 *  Rounded edges everywhere — visually coherent with the stylized
 *  character. No more visible knees-through-apron since the character
 *  now has proper bent legs. */
function PatientChair({ position, rotationY = 0 }: { position: [number, number, number]; rotationY?: number }) {
  const leatherProps = { color: PALETTE.leather, roughness: 0.75, metalness: 0.05 };
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      {/* Base / skirt — shorter in z (the seat-front direction after the
          chair's rotationY flip) so the seated patient's shoes extend
          past the front edge of the chair and are clearly visible. */}
      <RoundedBox args={[0.76, 0.42, 0.52]} radius={0.08} smoothness={3} position={[0, 0.21, -0.12]} castShadow receiveShadow>
        <meshStandardMaterial {...leatherProps} />
      </RoundedBox>
      {/* seat cushion — slightly inset on top */}
      <RoundedBox args={[0.68, 0.14, 0.68]} radius={0.07} smoothness={3} position={[0, 0.5, 0]} castShadow>
        <meshStandardMaterial color="#4a352a" roughness={0.72} />
      </RoundedBox>
      {/* cushion tuft — dimple in the middle */}
      <mesh position={[0, 0.58, 0]}>
        <sphereGeometry args={[0.03, 10, 10]} />
        <meshStandardMaterial color="#2a1a14" />
      </mesh>
      {/* backrest — taller, cushioned */}
      <RoundedBox args={[0.72, 1.0, 0.16]} radius={0.08} smoothness={3} position={[0, 1.0, -0.32]} castShadow>
        <meshStandardMaterial {...leatherProps} />
      </RoundedBox>
      {/* backrest cushion face */}
      <RoundedBox args={[0.6, 0.9, 0.06]} radius={0.06} smoothness={3} position={[0, 1.0, -0.24]} castShadow>
        <meshStandardMaterial color="#4a352a" roughness={0.72} />
      </RoundedBox>
      {/* armrests — rounded */}
      {[-0.38, 0.38].map((lx, i) => (
        <RoundedBox key={`arm-${i}`} args={[0.12, 0.36, 0.64]} radius={0.05} smoothness={3} position={[lx, 0.68, 0]} castShadow>
          <meshStandardMaterial {...leatherProps} />
        </RoundedBox>
      ))}
      {/* brass foot-cap accents */}
      {([[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]] as const).map(([lx, lz], i) => (
        <mesh key={`cap-${i}`} position={[lx, 0.03, lz]} castShadow>
          <cylinderGeometry args={[0.04, 0.04, 0.06, 12]} />
          <meshStandardMaterial color={PALETTE.brass} metalness={0.7} roughness={0.35} />
        </mesh>
      ))}
    </group>
  );
}

/** A seated human figure — torso upright, legs forward at 90°, arms on
 *  the thighs. Used for BOTH the patient in the patient chair and the
 *  doctor in the desk chair (different palette). */

function Lighting() {
  return (
    <>
      {/* Ambient — neutral so surfaces read their true color instead of
          everything drifting toward amber. Previously tinted warm which,
          on top of the hemisphere + directional, made the whole room look
          like a sepia filter. */}
      <ambientLight intensity={0.55} color="#ffffff" />
      {/* Soft sky / floor bounce — brighter + less saturated than before */}
      <hemisphereLight args={['#f6f0e4', '#a89a84', 0.7]} />
      {/* Key: "window" daylight through the left wall — still warm, just
          a touch less orange so walls don't look stained. */}
      <directionalLight
        position={[-10, 8, 4]}
        intensity={1.3}
        color="#fff0d4"
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-12}
        shadow-camera-right={12}
        shadow-camera-top={12}
        shadow-camera-bottom={-12}
        shadow-camera-near={0.1}
        shadow-camera-far={30}
      />
      {/* Fill from the opposite side — cooler, much softer, no shadows */}
      <directionalLight position={[6, 6, 6]} intensity={0.35} color="#c9d8e8" />
      {/* Rim behind the doctor to separate the back wall from the figure */}
      <directionalLight position={[0, 3, -8]} intensity={0.4} color="#ffb37a" />
      {/* Patient-chair fill — warm, practical */}
      <pointLight position={[0, 2.4, ROOM_BACK_Z + 4.2]} intensity={0.45} distance={6} color="#ffd89a" />
      {/* Desk fill — subtle emphasis on the doctor side */}
      <pointLight position={[0, 2.4, ROOM_BACK_Z + 1.6]} intensity={0.35} distance={5} color="#ffe4b8" />
    </>
  );
}

function CeilingLight({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      {/* recessed housing */}
      <mesh position={[0, 0.03, 0]}>
        <boxGeometry args={[1.6, 0.06, 0.5]} />
        <meshStandardMaterial color={PALETTE.woodDark} />
      </mesh>
      {/* diffuser panel */}
      <mesh>
        <boxGeometry args={[1.5, 0.04, 0.4]} />
        <meshStandardMaterial color="#fff6dc" emissive="#ffe6b0" emissiveIntensity={1.6} toneMapped={false} />
      </mesh>
      <pointLight intensity={0.35} distance={7} color="#ffe4b8" />
    </group>
  );
}

/** Patient summary shown on the monitor — null = empty/idle screen. */
interface MonitorPatient {
  id: string;
  name: string;
  age: number;
  gender: 'M' | 'F';
  chiefComplaint: string;
}

/** Canvas texture for the consultation desk monitor. Renders a calm patient
 *  record card (no vitals trace — this isn't an ICU monitor, just the
 *  doctor's desktop EMR application). The card is populated from the
 *  current polyclinic patient and uses the cozy MedKit palette. */
function makeMonitorTexture(patient: MonitorPatient | null): CanvasTexture {
  const w = 512, h = 320;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;

  // Sunshine cream background, matching --paper / --cream-2.
  ctx.fillStyle = '#FFF6E6';
  ctx.fillRect(0, 0, w, h);

  // Title bar — peach accent like the cozy app's primary CTA.
  ctx.fillStyle = '#FFB68A';
  ctx.fillRect(0, 0, w, 40);
  ctx.fillStyle = '#3B2A1F';
  ctx.font = 'bold 17px "Nunito", sans-serif';
  ctx.fillText('CRC train · 入组前沟通记录', 14, 26);
  ctx.fillStyle = '#5FCFA0';
  ctx.font = 'bold 12px "Nunito", sans-serif';
  ctx.fillText('● 入组沟通进行中', w - 150, 26);

  // Card frame with the signature plush outline.
  ctx.strokeStyle = '#2B1E16';
  ctx.lineWidth = 3;
  ctx.fillStyle = '#FFFFFF';
  const cardX = 18, cardY = 56, cardW = w - 36, cardH = h - 74;
  ctx.beginPath();
  ctx.roundRect(cardX, cardY, cardW, cardH, 14);
  ctx.fill();
  ctx.stroke();

  if (!patient) {
    ctx.fillStyle = '#8E7261';
    ctx.font = '600 14px "Nunito", sans-serif';
    ctx.fillText('No active patient. Accept the next patient to begin.', cardX + 18, cardY + cardH / 2);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  // Avatar circle (initials) — top-left of the card.
  const initials = patient.name.split(' ').map((s) => s[0]).slice(0, 2).join('');
  ctx.beginPath();
  ctx.arc(cardX + 44, cardY + 44, 26, 0, Math.PI * 2);
  ctx.fillStyle = '#FFD86B';
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.fillStyle = '#3B2A1F';
  ctx.font = 'bold 20px "Nunito", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(initials, cardX + 44, cardY + 51);
  ctx.textAlign = 'left';

  // Name + demographic header, right of the avatar.
  ctx.fillStyle = '#3B2A1F';
  ctx.font = 'bold 22px "Nunito", sans-serif';
  ctx.fillText(patient.name, cardX + 84, cardY + 38);
  ctx.fillStyle = '#6B4F3F';
  ctx.font = '600 14px "Nunito", sans-serif';
  ctx.fillText(`${patient.age} years · ${patient.gender === 'F' ? 'Female' : 'Male'}`, cardX + 84, cardY + 60);

  // Divider.
  ctx.strokeStyle = 'rgba(43,30,22,0.18)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 6]);
  ctx.beginPath();
  ctx.moveTo(cardX + 18, cardY + 88);
  ctx.lineTo(cardX + cardW - 18, cardY + 88);
  ctx.stroke();
  ctx.setLineDash([]);

  // Field rows.
  ctx.font = 'bold 11px "Nunito", sans-serif';
  ctx.fillStyle = '#8E7261';
  ctx.fillText('PATIENT ID', cardX + 18, cardY + 110);
  ctx.fillStyle = '#3B2A1F';
  ctx.font = '700 14px "Nunito", sans-serif';
  ctx.fillText(`#${patient.id.toUpperCase()}`, cardX + 18, cardY + 128);

  ctx.font = 'bold 11px "Nunito", sans-serif';
  ctx.fillStyle = '#8E7261';
  ctx.fillText('REASON FOR VISIT', cardX + 18, cardY + 156);
  ctx.fillStyle = '#3B2A1F';
  ctx.font = '700 13px "Nunito", sans-serif';
  // wrap chief complaint at ~52 chars
  const maxLineW = cardW - 36;
  const words = `"${patient.chiefComplaint}"`.split(' ');
  let line = '';
  let yPos = cardY + 176;
  for (const word of words) {
    const test = line + word + ' ';
    if (ctx.measureText(test).width > maxLineW && line) {
      ctx.fillText(line.trim(), cardX + 18, yPos);
      line = word + ' ';
      yPos += 18;
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line.trim(), cardX + 18, yPos);

  // Badges along the bottom — mood markers using the cozy chip language.
  const chipY = cardY + cardH - 30;
  drawChip(ctx, cardX + 18, chipY, '★ accepted', '#A8E5C8');
  drawChip(ctx, cardX + 124, chipY, '🎙 voice live', '#A6D8FF');
  drawChip(ctx, cardX + 246, chipY, 'OSCE training', '#FFD86B');

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function drawChip(ctx: CanvasRenderingContext2D, x: number, y: number, label: string, fill: string) {
  ctx.font = 'bold 11px "Nunito", sans-serif';
  const padX = 10;
  const w = ctx.measureText(label).width + padX * 2;
  const h = 22;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 11);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#2B1E16';
  ctx.stroke();
  ctx.fillStyle = '#3B2A1F';
  ctx.fillText(label, x + padX, y + 15);
}

/** Wide consultation desk — faces into the room (+z). Houses the computer
 *  archive interactable at its center. The monitor renders an EMR card
 *  populated by the current polyclinic patient. */
function DoctorDesk({
  position,
  patient,
}: {
  position: [number, number, number];
  patient: MonitorPatient | null;
}) {
  // Re-bake whenever the patient identity changes so the monitor reflects
  // the person actually sitting in the chair. Disposed on each rebuild.
  const monitorTex = useMemo(() => makeMonitorTexture(patient), [
    patient?.id,
    patient?.name,
    patient?.age,
    patient?.gender,
    patient?.chiefComplaint,
  ]);
  useEffect(() => () => monitorTex.dispose(), [monitorTex]);
  return (
    <group position={position}>
      {/* desk body — rounded, two-tone */}
      <RoundedBox args={[2.6, 0.76, 1.0]} radius={0.04} smoothness={3} position={[0, 0.38, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={PALETTE.wood} roughness={0.7} />
      </RoundedBox>
      {/* top surface — slightly wider, darker stained */}
      <RoundedBox args={[2.7, 0.06, 1.05]} radius={0.02} smoothness={3} position={[0, 0.79, 0]} castShadow>
        <meshStandardMaterial color={PALETTE.woodDark} roughness={0.5} />
      </RoundedBox>
      {/* apron detail strip */}
      <mesh position={[0, 0.55, 0.505]}>
        <boxGeometry args={[2.55, 0.04, 0.012]} />
        <meshStandardMaterial color={PALETTE.brass} metalness={0.6} roughness={0.4} />
      </mesh>

      {/* Monitor — sits on the doctor-half of the desk and is angled
          toward the doctor's seat (desk-local ~(0, _, −0.95)). Wrapping
          the head (frame + screen + LED) in a group rotated ~135° around
          Y makes its +z local face the chair. The base/neck stay axis-
          aligned like a real swivel stand. Sized down from the original
          so it no longer occludes the bookshelf behind it. */}
      {/* base + stand neck */}
      <mesh position={[-0.8, 0.82, -0.12]} castShadow>
        <cylinderGeometry args={[0.1, 0.12, 0.02, 20]} />
        <meshStandardMaterial color="#1a1a1a" metalness={0.4} />
      </mesh>
      <mesh position={[-0.8, 0.92, -0.12]} castShadow>
        <cylinderGeometry args={[0.018, 0.025, 0.2, 10]} />
        <meshStandardMaterial color="#1a1a1a" metalness={0.4} />
      </mesh>
      {/* rotating monitor head */}
      <group position={[-0.8, 1.17, -0.12]} rotation={[0, (3 * Math.PI) / 4, 0]}>
        <RoundedBox args={[0.52, 0.36, 0.04]} radius={0.012} smoothness={3} position={[0, 0, 0]} castShadow>
          <meshStandardMaterial color="#111" roughness={0.5} />
        </RoundedBox>
        <mesh position={[0, 0, 0.021]}>
          <planeGeometry args={[0.48, 0.32]} />
          <meshStandardMaterial
            map={monitorTex}
            emissive="#6a8aa8"
            emissiveIntensity={0.75}
            emissiveMap={monitorTex}
            toneMapped={false}
          />
        </mesh>
        {/* power-LED on the front bezel */}
        <mesh position={[0, -0.195, 0.021]}>
          <boxGeometry args={[0.06, 0.01, 0.003]} />
          <meshStandardMaterial color="#66a8e4" emissive="#66a8e4" emissiveIntensity={1.3} toneMapped={false} />
        </mesh>
      </group>
      {/* keyboard */}
      <RoundedBox args={[0.58, 0.025, 0.2]} radius={0.008} smoothness={2} position={[-0.8, 0.83, 0.2]} castShadow>
        <meshStandardMaterial color="#e4e0d6" roughness={0.55} />
      </RoundedBox>
      {/* mouse */}
      <RoundedBox args={[0.07, 0.025, 0.11]} radius={0.012} smoothness={3} position={[-0.3, 0.83, 0.22]} castShadow>
        <meshStandardMaterial color="#1a1a1a" roughness={0.5} />
      </RoundedBox>
      {/* stethoscope — lying flat on the desk. A single horizontal black ring
          (the tubing) with a chrome chest piece at the south and two tiny
          earpiece knobs at the north. Much cleaner silhouette than the old
          articulated version. */}
      <group position={[0.4, 0.813, 0.15]}>
        {/* tubing loop — lies flat on the desk surface */}
        <mesh rotation={[Math.PI / 2, 0, 0]} castShadow>
          <torusGeometry args={[0.12, 0.011, 10, 32]} />
          <meshStandardMaterial color="#141414" roughness={0.55} />
        </mesh>
        {/* chest piece — chrome disc at the far (south) end of the ring */}
        <group position={[0, 0.012, 0.13]}>
          <mesh castShadow>
            <cylinderGeometry args={[0.045, 0.045, 0.018, 22]} />
            <meshStandardMaterial color="#bcbcbc" metalness={0.85} roughness={0.2} />
          </mesh>
          <mesh position={[0, 0.011, 0]}>
            <cylinderGeometry args={[0.04, 0.04, 0.003, 22]} />
            <meshStandardMaterial color="#dcdcdc" roughness={0.3} />
          </mesh>
        </group>
        {/* two earpiece knobs on the near (north) end */}
        {[-0.022, 0.022].map((dx, i) => (
          <mesh key={`ep-${i}`} position={[dx, 0.015, -0.12]} castShadow>
            <sphereGeometry args={[0.014, 10, 8]} />
            <meshStandardMaterial color="#141414" />
          </mesh>
        ))}
      </group>

      {/* clipboard — wooden backer + paper + metal clip + "Rx" label */}
      <group position={[0.75, 0.83, -0.15]} rotation={[0, 0.08, 0]}>
        <RoundedBox args={[0.38, 0.02, 0.5]} radius={0.01} smoothness={2} position={[0, 0, 0]} castShadow>
          <meshStandardMaterial color="#6a4a2a" roughness={0.85} />
        </RoundedBox>
        {/* paper on top */}
        <mesh position={[0, 0.013, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[0.32, 0.44]} />
          <meshStandardMaterial color={PALETTE.paper} />
        </mesh>
        {/* metal clip */}
        <RoundedBox args={[0.12, 0.02, 0.04]} radius={0.008} smoothness={2} position={[0, 0.025, -0.22]} castShadow>
          <meshStandardMaterial color="#9a9a9a" metalness={0.7} roughness={0.3} />
        </RoundedBox>
        {/* "Rx" label on the paper — readable at desk height */}
        <Text position={[-0.1, 0.02, -0.14]} rotation={[-Math.PI / 2, 0, 0]} fontSize={0.048} color="#6a2414" anchorX="center" anchorY="middle" fontWeight={900}>
          Rx
        </Text>
        <Text position={[0.03, 0.02, -0.14]} rotation={[-Math.PI / 2, 0, 0]} fontSize={0.024} color="#3a3a3a" anchorX="left" anchorY="middle">
          受试者: ___________
        </Text>
        {/* simulated lines of handwriting */}
        {[-0.06, -0.02, 0.02, 0.06, 0.1].map((dz, i) => (
          <mesh key={`line-${i}`} position={[0, 0.018, dz]}>
            <boxGeometry args={[0.24, 0.001, 0.002]} />
            <meshStandardMaterial color="#8a8578" />
          </mesh>
        ))}
      </group>

      {/* pen — next to the clipboard */}
      <mesh position={[0.85, 0.85, -0.05]} rotation={[0, 0.2, Math.PI / 2]} castShadow>
        <cylinderGeometry args={[0.01, 0.01, 0.18, 10]} />
        <meshStandardMaterial color="#b8321c" />
      </mesh>
      <mesh position={[0.94, 0.85, -0.05]} rotation={[0, 0.2, Math.PI / 2]} castShadow>
        <cylinderGeometry args={[0.006, 0.01, 0.02, 10]} />
        <meshStandardMaterial color="#1a1a1a" />
      </mesh>
      {/* small lamp */}
      <group position={[1.15, 0.83, -0.25]}>
        <mesh castShadow>
          <cylinderGeometry args={[0.08, 0.1, 0.03, 12]} />
          <meshStandardMaterial color={PALETTE.woodDark} />
        </mesh>
        <mesh position={[0, 0.18, 0]} castShadow>
          <cylinderGeometry args={[0.01, 0.01, 0.35, 6]} />
          <meshStandardMaterial color="#2a2a2a" />
        </mesh>
        <mesh position={[0, 0.42, 0]} castShadow>
          <coneGeometry args={[0.1, 0.14, 12, 1, true]} />
          <meshStandardMaterial color={PALETTE.accent} emissive={PALETTE.accent} emissiveIntensity={0.8} toneMapped={false} />
        </mesh>
        {/* warm glow from under the shade */}
        <pointLight position={[0, 0.35, 0]} intensity={0.45} distance={2.2} color="#ffb36a" />
      </group>

      {/* ceramic coffee mug — clean cylinder + vertical ring handle on the
          side. Torus sits in the YZ plane so it reads as a real mug handle
          from any angle. */}
      <group position={[-0.25, 0.83, 0.25]}>
        {/* body */}
        <mesh castShadow>
          <cylinderGeometry args={[0.05, 0.045, 0.13, 24]} />
          <meshStandardMaterial color="#f2d8b0" roughness={0.4} />
        </mesh>
        {/* accent band near the rim */}
        <mesh position={[0, 0.05, 0]}>
          <cylinderGeometry args={[0.0505, 0.0505, 0.015, 24]} />
          <meshStandardMaterial color={PALETTE.accent} />
        </mesh>
        {/* coffee surface at the top */}
        <mesh position={[0, 0.064, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[0.044, 20]} />
          <meshStandardMaterial color="#3a2414" roughness={0.4} />
        </mesh>
        {/* handle — vertical ring, plane YZ, facing +X side of the mug */}
        <mesh position={[0.078, 0, 0]} rotation={[0, Math.PI / 2, 0]} castShadow>
          <torusGeometry args={[0.032, 0.009, 10, 18]} />
          <meshStandardMaterial color="#f2d8b0" roughness={0.4} />
        </mesh>
      </group>

      {/* pen holder cup with pens — single tidy cluster of desk stationery */}
      <group position={[-0.45, 0.83, -0.3]}>
        <mesh castShadow>
          <cylinderGeometry args={[0.045, 0.04, 0.11, 14]} />
          <meshStandardMaterial color={PALETTE.leather} roughness={0.7} />
        </mesh>
        {[[0, 0.02], [0.015, -0.01], [-0.012, 0.012]].map(([dx, dz], i) => (
          <mesh key={`pen-${i}`} position={[dx, 0.11 + i * 0.01, dz]} rotation={[0.08 * (i - 1), 0, 0.04 * i]} castShadow>
            <cylinderGeometry args={[0.005, 0.005, 0.16, 8]} />
            <meshStandardMaterial color={['#c4463a', '#2a5a8a', '#1a1a1a'][i]} />
          </mesh>
        ))}
      </group>
    </group>
  );
}

/** Executive chair for the doctor (behind the desk). */
function DoctorChair({ position, rotationY = 0 }: { position: [number, number, number]; rotationY?: number }) {
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <mesh position={[0, 0.5, 0]} castShadow>
        <cylinderGeometry args={[0.3, 0.3, 0.08, 16]} />
        <meshStandardMaterial color={PALETTE.leather} />
      </mesh>
      <mesh position={[0, 1.0, -0.3]} castShadow>
        <boxGeometry args={[0.55, 0.75, 0.08]} />
        <meshStandardMaterial color={PALETTE.leather} />
      </mesh>
      {/* armrests */}
      {[-0.32, 0.32].map((lx, i) => (
        <mesh key={i} position={[lx, 0.65, -0.05]} castShadow>
          <boxGeometry args={[0.08, 0.1, 0.35]} />
          <meshStandardMaterial color={PALETTE.leather} />
        </mesh>
      ))}
      <mesh position={[0, 0.25, 0]} castShadow>
        <cylinderGeometry args={[0.04, 0.04, 0.5, 8]} />
        <meshStandardMaterial color="#2a2a2a" metalness={0.5} />
      </mesh>
      <mesh position={[0, 0.03, 0]} castShadow>
        <cylinderGeometry args={[0.32, 0.32, 0.05, 16]} />
        <meshStandardMaterial color="#2a2a2a" metalness={0.5} />
      </mesh>
    </group>
  );
}

/** Bookshelf against a wall — decorative, conveys "muayenehane" vibe. */
function Bookshelf({ position, rotationY = 0 }: { position: [number, number, number]; rotationY?: number }) {
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      {/* outer frame */}
      <mesh position={[0, 1.0, 0]} castShadow>
        <boxGeometry args={[1.1, 2.0, 0.4]} />
        <meshStandardMaterial color={PALETTE.woodDark} />
      </mesh>
      {/* shelves */}
      {[0.35, 0.85, 1.35, 1.85].map((y, i) => (
        <mesh key={`shelf-${i}`} position={[0, y, 0.02]} castShadow>
          <boxGeometry args={[1.02, 0.04, 0.34]} />
          <meshStandardMaterial color={PALETTE.wood} />
        </mesh>
      ))}
      {/* books on each shelf */}
      {[0.55, 1.05, 1.55].map((y, row) =>
        [-0.4, -0.25, -0.1, 0.08, 0.22, 0.38].map((x, i) => {
          const palette = ['#a04a4a', '#4a6a8a', '#8a6e3a', '#5a7a4a', '#8a4a8a', '#3a5a6a'];
          const h = 0.3 + ((row + i) * 0.07) % 0.14;
          return (
            <mesh key={`book-${row}-${i}`} position={[x, y + h / 2 - 0.15, 0.06]} castShadow>
              <boxGeometry args={[0.12, h, 0.22]} />
              <meshStandardMaterial color={palette[(row + i) % palette.length]} roughness={0.85} />
            </mesh>
          );
        })
      )}
    </group>
  );
}


// ───────── Canvas-based realistic textures ─────────
//
// For "real-looking" diplomas, anatomy charts, etc., we paint to an offscreen
// canvas and wrap it as a THREE.CanvasTexture. No external image assets — it
// all ships with the app and stays fully offline.

function makeDiplomaTexture(
  institution: string,
  degree: string,
  name: string,
  year: string,
  sealColor: string = '#8a0a0a'
): CanvasTexture {
  const w = 512, h = 384;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d')!;

  // Parchment gradient background
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#fbf3dc');
  bg.addColorStop(1, '#e8d9b0');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // Subtle noise / paper texture
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = `rgba(120,100,60,${0.01 + Math.random() * 0.03})`;
    ctx.fillRect(Math.random() * w, Math.random() * h, 1, 1);
  }

  // Outer gold border
  ctx.strokeStyle = '#b8860b';
  ctx.lineWidth = 10;
  ctx.strokeRect(10, 10, w - 20, h - 20);
  // Inner thin line
  ctx.strokeStyle = '#daa520';
  ctx.lineWidth = 2;
  ctx.strokeRect(24, 24, w - 48, h - 48);
  // Corner flourishes
  ctx.strokeStyle = '#b8860b';
  ctx.lineWidth = 3;
  const drawCorner = (cx: number, cy: number, dx: number, dy: number) => {
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.quadraticCurveTo(cx + dx * 0.5, cy + dy * 0.5, cx + dx, cy);
    ctx.quadraticCurveTo(cx + dx * 0.5, cy + dy * 0.5, cx, cy + dy);
    ctx.stroke();
  };
  drawCorner(35, 35, 40, 40);
  drawCorner(w - 35, 35, -40, 40);
  drawCorner(35, h - 35, 40, -40);
  drawCorner(w - 35, h - 35, -40, -40);

  // Header: institution name
  ctx.fillStyle = '#3a1d08';
  ctx.textAlign = 'center';
  ctx.font = 'bold 26px "Times New Roman", serif';
  ctx.fillText(institution.toUpperCase(), w / 2, 78);

  // Divider
  ctx.strokeStyle = '#8a5010';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(w * 0.25, 92);
  ctx.lineTo(w * 0.75, 92);
  ctx.stroke();

  // Subtitle
  ctx.font = 'italic 15px "Times New Roman", serif';
  ctx.fillStyle = '#5a3010';
  ctx.fillText('hereby confers upon', w / 2, 118);

  // Honoree name
  ctx.font = 'bold italic 30px "Times New Roman", serif';
  ctx.fillStyle = '#2a1005';
  ctx.fillText(name, w / 2, 158);

  // Degree
  ctx.font = 'italic 14px "Times New Roman", serif';
  ctx.fillStyle = '#5a3010';
  ctx.fillText('the degree of', w / 2, 184);
  ctx.font = 'bold 22px "Times New Roman", serif';
  ctx.fillStyle = '#6a2a10';
  ctx.fillText(degree.toUpperCase(), w / 2, 214);

  // Seal — concentric circles with text
  const cx = 115, cy = 300;
  ctx.beginPath();
  ctx.arc(cx, cy, 44, 0, Math.PI * 2);
  ctx.fillStyle = sealColor;
  ctx.fill();
  ctx.strokeStyle = '#4a0505';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, 36, 0, Math.PI * 2);
  ctx.strokeStyle = '#c7a350';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // Star in the middle
  ctx.fillStyle = '#f4d078';
  const drawStar = (cxx: number, cyy: number, spikes: number, outer: number, inner: number) => {
    let rot = (Math.PI / 2) * 3;
    const step = Math.PI / spikes;
    ctx.beginPath();
    ctx.moveTo(cxx, cyy - outer);
    for (let s = 0; s < spikes; s++) {
      ctx.lineTo(cxx + Math.cos(rot) * outer, cyy + Math.sin(rot) * outer);
      rot += step;
      ctx.lineTo(cxx + Math.cos(rot) * inner, cyy + Math.sin(rot) * inner);
      rot += step;
    }
    ctx.lineTo(cxx, cyy - outer);
    ctx.closePath();
    ctx.fill();
  };
  drawStar(cx, cy, 5, 14, 6);
  // Circular text around the seal
  ctx.fillStyle = '#f4d078';
  ctx.font = 'bold 9px sans-serif';
  const circText = '★ OFFICIAL SEAL OF MEDICINE ★';
  const radius = 40;
  for (let i = 0; i < circText.length; i++) {
    const a = -Math.PI / 2 + (i / circText.length) * Math.PI * 2;
    ctx.save();
    ctx.translate(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
    ctx.rotate(a + Math.PI / 2);
    ctx.fillText(circText[i], 0, 0);
    ctx.restore();
  }

  // Signature block (right)
  ctx.strokeStyle = '#2a1005';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(260, 295);
  ctx.lineTo(460, 295);
  ctx.stroke();
  ctx.font = 'italic 22px "Brush Script MT", cursive';
  ctx.fillStyle = '#2a1005';
  ctx.textAlign = 'center';
  ctx.fillText(`${name.split(' ').pop() ?? 'Director'}, MD`, 360, 287);
  ctx.font = '11px "Times New Roman", serif';
  ctx.fillStyle = '#4a2a10';
  ctx.fillText('Dean, Faculty of Medicine', 360, 312);

  // Year
  ctx.font = 'bold 20px "Times New Roman", serif';
  ctx.fillStyle = '#3a1d08';
  ctx.fillText(`Class of ${year}`, w / 2, 355);

  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  return tex;
}

function makeAnatomyChartTexture(): CanvasTexture {
  const w = 512, h = 768;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d')!;

  // Aged parchment background with a subtle gradient.
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#f5ecd4');
  bg.addColorStop(1, '#e8dcb8');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // Vintage texture specks.
  ctx.fillStyle = 'rgba(90,48,16,0.04)';
  for (let i = 0; i < 320; i++) {
    ctx.fillRect(Math.random() * w, Math.random() * h, Math.random() * 2, Math.random() * 2);
  }

  // Title block.
  ctx.fillStyle = '#4a1f0a';
  ctx.font = 'bold 32px "Times New Roman", serif';
  ctx.textAlign = 'center';
  ctx.fillText('HUMAN ANATOMY', w / 2, 46);
  ctx.font = 'italic 15px "Times New Roman", serif';
  ctx.fillStyle = '#5a2818';
  ctx.fillText('Organa Thoracis et Abdominis', w / 2, 70);
  ctx.strokeStyle = '#5a2818';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(w * 0.15, 82); ctx.lineTo(w * 0.85, 82); ctx.stroke();

  const cx = w / 2;

  // ───────── Body silhouette — front-facing, muscled proportions ─────────
  ctx.strokeStyle = '#3a2010';
  ctx.lineWidth = 2;
  ctx.fillStyle = '#f7ebd0';

  // Head
  ctx.beginPath();
  ctx.ellipse(cx, 150, 48, 58, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Neck + trapezius
  ctx.beginPath();
  ctx.moveTo(cx - 28, 208);
  ctx.quadraticCurveTo(cx - 75, 232, cx - 115, 248);
  ctx.quadraticCurveTo(cx - 130, 260, cx - 125, 290);
  ctx.lineTo(cx - 120, 340);   // shoulder to upper arm line
  ctx.quadraticCurveTo(cx - 140, 430, cx - 135, 510); // arm hangs
  ctx.lineTo(cx - 120, 560);
  ctx.lineTo(cx - 70, 560);    // waist cut
  ctx.lineTo(cx - 75, 640);    // hip
  ctx.lineTo(cx - 90, 720);    // thigh outer
  ctx.lineTo(cx - 40, 735);    // foot cut
  ctx.lineTo(cx - 20, 735);
  ctx.lineTo(cx - 15, 640);    // inner thigh
  ctx.lineTo(cx + 15, 640);
  ctx.lineTo(cx + 20, 735);
  ctx.lineTo(cx + 40, 735);
  ctx.lineTo(cx + 90, 720);
  ctx.lineTo(cx + 75, 640);
  ctx.lineTo(cx + 70, 560);
  ctx.lineTo(cx + 120, 560);
  ctx.lineTo(cx + 135, 510);
  ctx.quadraticCurveTo(cx + 140, 430, cx + 120, 340);
  ctx.lineTo(cx + 125, 290);
  ctx.quadraticCurveTo(cx + 130, 260, cx + 115, 248);
  ctx.quadraticCurveTo(cx + 75, 232, cx + 28, 208);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // ───────── Skeleton hints (thin, behind organs) ─────────
  ctx.strokeStyle = 'rgba(60,40,20,0.35)';
  ctx.lineWidth = 1;
  // Spine
  ctx.beginPath();
  ctx.moveTo(cx, 220);
  ctx.lineTo(cx, 560);
  ctx.stroke();
  // Ribs
  for (let i = 0; i < 8; i++) {
    const y = 260 + i * 20;
    const widthR = 82 - i * 3;
    ctx.beginPath();
    ctx.arc(cx, y, widthR, Math.PI, 0);
    ctx.stroke();
  }
  // Clavicles
  ctx.beginPath();
  ctx.moveTo(cx - 90, 250); ctx.lineTo(cx - 15, 235);
  ctx.moveTo(cx + 90, 250); ctx.lineTo(cx + 15, 235);
  ctx.stroke();
  // Pelvis bowl
  ctx.beginPath();
  ctx.moveTo(cx - 75, 570);
  ctx.quadraticCurveTo(cx, 625, cx + 75, 570);
  ctx.stroke();

  // ───────── ORGANS (labelled) ─────────
  ctx.strokeStyle = '#4a1808';
  ctx.lineWidth = 1.2;

  // Trachea
  ctx.fillStyle = '#d4b898';
  ctx.fillRect(cx - 6, 220, 12, 42);
  ctx.strokeRect(cx - 6, 220, 12, 42);

  // Lungs (both sides, slightly uneven to reflect heart indent on left)
  ctx.fillStyle = '#f0b0b4';
  // right (image-left)
  ctx.beginPath();
  ctx.moveTo(cx - 20, 264);
  ctx.quadraticCurveTo(cx - 95, 272, cx - 105, 340);
  ctx.quadraticCurveTo(cx - 95, 410, cx - 45, 410);
  ctx.lineTo(cx - 25, 400);
  ctx.lineTo(cx - 20, 264);
  ctx.fill(); ctx.stroke();
  // left (image-right, with cardiac notch)
  ctx.beginPath();
  ctx.moveTo(cx + 20, 264);
  ctx.lineTo(cx + 25, 320);
  ctx.quadraticCurveTo(cx + 15, 360, cx + 35, 395);
  ctx.lineTo(cx + 50, 410);
  ctx.quadraticCurveTo(cx + 98, 410, cx + 105, 340);
  ctx.quadraticCurveTo(cx + 95, 272, cx + 20, 264);
  ctx.fill(); ctx.stroke();
  // lung lobar fissures
  ctx.strokeStyle = 'rgba(140,50,50,0.5)';
  ctx.beginPath();
  ctx.moveTo(cx - 90, 310); ctx.lineTo(cx - 40, 360);
  ctx.moveTo(cx + 90, 310); ctx.lineTo(cx + 55, 360);
  ctx.stroke();

  // Heart — nested in between lungs
  ctx.fillStyle = '#b83628';
  ctx.beginPath();
  ctx.moveTo(cx - 8, 320);
  ctx.bezierCurveTo(cx - 40, 310, cx - 40, 360, cx - 5, 388);
  ctx.bezierCurveTo(cx + 35, 360, cx + 40, 300, cx + 8, 320);
  ctx.quadraticCurveTo(cx, 310, cx - 8, 320);
  ctx.fill();
  ctx.strokeStyle = '#6a1208';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // Aorta arch
  ctx.strokeStyle = '#8a1a10';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx + 6, 312);
  ctx.bezierCurveTo(cx + 30, 290, cx - 20, 275, cx - 10, 312);
  ctx.stroke();

  // Diaphragm (dashed line)
  ctx.strokeStyle = 'rgba(70,40,15,0.55)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(cx - 95, 425);
  ctx.quadraticCurveTo(cx, 405, cx + 95, 425);
  ctx.stroke();
  ctx.setLineDash([]);

  // Liver (brown, large, right side of image = patient's right)
  ctx.fillStyle = '#6a3418';
  ctx.beginPath();
  ctx.moveTo(cx - 90, 440);
  ctx.quadraticCurveTo(cx - 100, 490, cx - 70, 500);
  ctx.lineTo(cx + 30, 490);
  ctx.quadraticCurveTo(cx + 10, 430, cx - 90, 440);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#3a1a08';
  ctx.lineWidth = 1.2;
  ctx.stroke();

  // Stomach
  ctx.fillStyle = '#e8a078';
  ctx.beginPath();
  ctx.moveTo(cx + 10, 440);
  ctx.bezierCurveTo(cx + 75, 430, cx + 85, 490, cx + 30, 495);
  ctx.bezierCurveTo(cx + 15, 495, cx + 5, 470, cx + 10, 440);
  ctx.fill();
  ctx.stroke();

  // Spleen (left)
  ctx.fillStyle = '#8a3a6a';
  ctx.beginPath();
  ctx.ellipse(cx + 85, 470, 18, 10, -0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Intestines — coiled mass below stomach
  ctx.fillStyle = '#e8c096';
  ctx.beginPath();
  ctx.ellipse(cx, 540, 75, 40, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  // Coil loops
  ctx.strokeStyle = 'rgba(90,50,20,0.65)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 6; i++) {
    ctx.beginPath();
    ctx.ellipse(cx - 50 + i * 18, 525 + (i % 2) * 10, 12, 8, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(cx - 42 + i * 18, 555 - (i % 2) * 10, 11, 7, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Kidneys (bean shape, behind intestines — dashed for 'hidden')
  ctx.fillStyle = '#8a2a1a';
  ctx.strokeStyle = '#4a1208';
  for (const sd of [-1, 1] as const) {
    ctx.beginPath();
    ctx.ellipse(cx + sd * 32, 485, 12, 20, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // Bladder
  ctx.fillStyle = '#f0d488';
  ctx.beginPath();
  ctx.ellipse(cx, 600, 18, 12, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#5a3a10';
  ctx.stroke();

  // ───────── Labels (with leader lines) ─────────
  ctx.strokeStyle = '#3a1f0a';
  ctx.lineWidth = 0.8;
  ctx.fillStyle = '#2a1508';
  ctx.font = 'italic 13px "Times New Roman", serif';

  const label = (text: string, sx: number, sy: number, tx: number, ty: number) => {
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(tx, ty);
    ctx.stroke();
    ctx.textAlign = tx > cx ? 'left' : 'right';
    ctx.fillText(text, tx + (tx > cx ? 4 : -4), ty + 4);
  };

  label('Pulmo dexter', cx - 80, 330, 30, 320);
  label('Pulmo sinister', cx + 80, 330, w - 30, 320);
  label('Cor', cx, 355, w - 30, 360);
  label('Aorta', cx - 5, 298, 30, 280);
  label('Trachea', cx - 5, 240, 30, 230);
  label('Hepar', cx - 50, 470, 30, 450);
  label('Gaster', cx + 45, 465, w - 30, 440);
  label('Lien', cx + 85, 472, w - 30, 485);
  label('Ren', cx - 32, 485, 30, 510);
  label('Intestinum', cx, 575, w - 30, 560);
  label('Vesica urinaria', cx, 600, w - 30, 605);

  // Frame bleed at corners.
  ctx.strokeStyle = 'rgba(60,30,10,0.25)';
  ctx.lineWidth = 6;
  ctx.strokeRect(12, 12, w - 24, h - 24);

  // Bottom credit.
  ctx.fillStyle = '#4a1f0a';
  ctx.font = 'italic 11px "Times New Roman", serif';
  ctx.textAlign = 'center';
  ctx.fillText("Gray's Atlas of Human Anatomy — Plate XIV", w / 2, h - 24);

  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  return tex;
}

/** Framed diploma — canvas texture gives it the parchment/gold/seal look. */
function Diploma({
  position,
  rotationY = 0,
  width = 0.9,
  height = 0.68,
  institution,
  degree,
  name,
  year,
  sealColor,
}: {
  position: [number, number, number];
  rotationY?: number;
  width?: number;
  height?: number;
  institution: string;
  degree: string;
  name: string;
  year: string;
  sealColor?: string;
}) {
  const texture = useMemo(
    () => makeDiplomaTexture(institution, degree, name, year, sealColor),
    [institution, degree, name, year, sealColor]
  );
  useEffect(() => () => texture.dispose(), [texture]);
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      {/* gold frame */}
      <mesh castShadow>
        <boxGeometry args={[width + 0.06, height + 0.06, 0.04]} />
        <meshStandardMaterial color="#b8860b" metalness={0.65} roughness={0.35} />
      </mesh>
      {/* inner mat */}
      <mesh position={[0, 0, 0.025]}>
        <boxGeometry args={[width - 0.01, height - 0.01, 0.01]} />
        <meshStandardMaterial color="#fbf3dc" />
      </mesh>
      {/* diploma surface */}
      <mesh position={[0, 0, 0.035]}>
        <planeGeometry args={[width - 0.02, height - 0.02]} />
        <meshStandardMaterial map={texture} />
      </mesh>
    </group>
  );
}

/** A wall-hung group of three framed diplomas on the back wall. */
function WallDiplomas() {
  return (
    <group>
      <Diploma
        position={[2.6, 2.05, ROOM_BACK_Z + 0.17]}
        institution="Istanbul Faculty of Medicine"
        degree="Doctor of Medicine"
        name="Dr. Ahmet Yilmaz"
        year="2012"
      />
      <Diploma
        position={[3.9, 2.05, ROOM_BACK_Z + 0.17]}
        institution="Hacettepe University"
        degree="Board of Internal Medicine"
        name="Dr. Ahmet Yilmaz"
        year="2016"
        sealColor="#10507a"
      />
      <Diploma
        position={[3.25, 1.0, ROOM_BACK_Z + 0.17]}
        width={1.1}
        height={0.8}
        institution="Ministry of Health"
        degree="Specialist Practitioner"
        name="Dr. Ahmet Yilmaz"
        year="2019"
        sealColor="#1a6a3a"
      />
    </group>
  );
}

/** Realistic anatomy chart — framed with a canvas texture. */
function AnatomyPoster({ position, rotationY = 0 }: { position: [number, number, number]; rotationY?: number }) {
  const texture = useMemo(() => makeAnatomyChartTexture(), []);
  useEffect(() => () => texture.dispose(), [texture]);
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <mesh castShadow>
        <boxGeometry args={[0.96, 1.34, 0.04]} />
        <meshStandardMaterial color={PALETTE.woodDark} />
      </mesh>
      <mesh position={[0, 0, 0.025]}>
        <planeGeometry args={[0.88, 1.26]} />
        <meshStandardMaterial map={texture} />
      </mesh>
    </group>
  );
}

/** Glass-front medicine cabinet with labeled bottles on shelves. */
function MedicineCabinet({ position, rotationY = 0 }: { position: [number, number, number]; rotationY?: number }) {
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <mesh castShadow>
        <boxGeometry args={[1.0, 1.3, 0.3]} />
        <meshStandardMaterial color="#f0ebe1" />
      </mesh>
      {/* glass front */}
      <mesh position={[0, 0, 0.16]}>
        <boxGeometry args={[0.9, 1.2, 0.02]} />
        <meshStandardMaterial color="#bcd8ea" transparent opacity={0.35} metalness={0.6} roughness={0.15} />
      </mesh>
      {/* shelves */}
      {[-0.35, 0, 0.35].map((y, i) => (
        <mesh key={`shelf-${i}`} position={[0, y, 0]}>
          <boxGeometry args={[0.9, 0.02, 0.28]} />
          <meshStandardMaterial color={PALETTE.wood} />
        </mesh>
      ))}
      {/* bottles on each shelf */}
      {[-0.35, 0, 0.35].map((shelfY, row) =>
        [-0.32, -0.12, 0.08, 0.28].map((x, i) => {
          const palette = ['#a83c3c', '#c6a878', '#e8d488', '#88a8d4', '#a8c488'];
          const color = palette[(row * 4 + i) % palette.length];
          return (
            <mesh key={`b-${row}-${i}`} position={[x, shelfY + 0.12, 0]} castShadow>
              <cylinderGeometry args={[0.05, 0.06, 0.2, 10]} />
              <meshStandardMaterial color={color} />
            </mesh>
          );
        })
      )}
      {/* cabinet handles */}
      <mesh position={[0.35, 0, 0.17]} castShadow>
        <cylinderGeometry args={[0.015, 0.015, 0.14, 8]} />
        <meshStandardMaterial color="#c0c0c0" metalness={0.8} roughness={0.2} />
      </mesh>
      {/* red cross emblem on top */}
      <mesh position={[0, 0.75, 0.155]}>
        <boxGeometry args={[0.14, 0.04, 0.015]} />
        <meshStandardMaterial color="#b83c3c" emissive="#b83c3c" emissiveIntensity={0.3} />
      </mesh>
      <mesh position={[0, 0.75, 0.155]}>
        <boxGeometry args={[0.04, 0.14, 0.015]} />
        <meshStandardMaterial color="#b83c3c" emissive="#b83c3c" emissiveIntensity={0.3} />
      </mesh>
    </group>
  );
}

/** 4-drawer filing cabinet. */
function FilingCabinet({ position, rotationY = 0 }: { position: [number, number, number]; rotationY?: number }) {
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <mesh position={[0, 0.65, 0]} castShadow>
        <boxGeometry args={[0.55, 1.3, 0.55]} />
        <meshStandardMaterial color="#4a5560" metalness={0.4} roughness={0.6} />
      </mesh>
      {/* drawer seams + handles */}
      {[0.25, 0.6, 0.95, 1.25].map((y, i) => (
        <group key={`drawer-${i}`}>
          <mesh position={[0, y, 0.28]}>
            <boxGeometry args={[0.55, 0.02, 0.02]} />
            <meshStandardMaterial color="#2a3540" />
          </mesh>
          <mesh position={[0, y + 0.12, 0.29]} castShadow>
            <boxGeometry args={[0.14, 0.04, 0.03]} />
            <meshStandardMaterial color="#c0c0c0" metalness={0.7} roughness={0.3} />
          </mesh>
        </group>
      ))}
      {/* file label tags */}
      {[0.32, 0.67, 1.02, 1.32].map((y, i) => (
        <mesh key={`tag-${i}`} position={[-0.18, y, 0.285]}>
          <boxGeometry args={[0.14, 0.04, 0.005]} />
          <meshStandardMaterial color="#fbf7ec" />
        </mesh>
      ))}
    </group>
  );
}

/** Wall clock — round face with hour/minute hands. Hands sweep every frame. */
function WallClock({ position, rotationY = 0 }: { position: [number, number, number]; rotationY?: number }) {
  const hourRef = useRef<Group>(null);
  const minRef = useRef<Group>(null);
  useFrame(() => {
    const d = new Date();
    const hours = d.getHours() % 12;
    const minutes = d.getMinutes();
    const seconds = d.getSeconds();
    if (hourRef.current) {
      hourRef.current.rotation.z = -((hours + minutes / 60) / 12) * Math.PI * 2;
    }
    if (minRef.current) {
      minRef.current.rotation.z = -((minutes + seconds / 60) / 60) * Math.PI * 2;
    }
  });
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      {/* rim */}
      <mesh castShadow>
        <cylinderGeometry args={[0.24, 0.24, 0.04, 24]} />
        <meshStandardMaterial color="#2a2a2a" metalness={0.5} roughness={0.4} />
      </mesh>
      {/* face */}
      <mesh position={[0, 0, 0.022]} rotation={[Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.22, 24]} />
        <meshStandardMaterial color="#fbf7ec" />
      </mesh>
      {/* hour markers */}
      {Array.from({ length: 12 }).map((_, i) => {
        const a = (i / 12) * Math.PI * 2;
        const r = 0.185;
        return (
          <mesh key={`h-${i}`} position={[Math.sin(a) * r, Math.cos(a) * r, 0.03]}>
            <boxGeometry args={[0.012, 0.03, 0.002]} />
            <meshStandardMaterial color="#1a1a1a" />
          </mesh>
        );
      })}
      {/* hour hand */}
      <group ref={hourRef} position={[0, 0, 0.035]}>
        <mesh position={[0, 0.055, 0]}>
          <boxGeometry args={[0.018, 0.12, 0.005]} />
          <meshStandardMaterial color="#1a1a1a" />
        </mesh>
      </group>
      {/* minute hand */}
      <group ref={minRef} position={[0, 0, 0.04]}>
        <mesh position={[0, 0.085, 0]}>
          <boxGeometry args={[0.012, 0.17, 0.005]} />
          <meshStandardMaterial color="#1a1a1a" />
        </mesh>
      </group>
      {/* hub */}
      <mesh position={[0, 0, 0.045]}>
        <cylinderGeometry args={[0.015, 0.015, 0.01, 12]} />
        <meshStandardMaterial color={PALETTE.accent} />
      </mesh>
    </group>
  );
}

/** Coat rack — tall post with hooks and three hung coats (spare white
 *  doctor coat, wool jacket, patient overcoat). Reads as a real coatstand
 *  with actual clothes on it. */
function CoatRack({ position }: { position: [number, number, number] }) {
  const COATS: Array<{ angle: number; color: string; height: number; width: number; shoulder: string }> = [
    { angle: 0.0, color: '#f8f4ea', height: 1.0, width: 0.5, shoulder: '#e6dfd0' },       // spare white coat
    { angle: Math.PI / 2, color: '#3a3530', height: 0.85, width: 0.46, shoulder: '#2a2520' }, // wool overcoat
    { angle: Math.PI, color: '#5a6a8a', height: 0.9, width: 0.44, shoulder: '#4a5a78' },   // blue jacket
  ];
  return (
    <group position={position}>
      {/* heavy wooden base — wider so the stand reads as stable */}
      <mesh position={[0, 0.04, 0]} castShadow>
        <cylinderGeometry args={[0.26, 0.3, 0.08, 18]} />
        <meshStandardMaterial color={PALETTE.woodDark} roughness={0.75} />
      </mesh>
      {/* base accent ring */}
      <mesh position={[0, 0.085, 0]}>
        <torusGeometry args={[0.24, 0.012, 8, 20]} />
        <meshStandardMaterial color={PALETTE.brass} metalness={0.65} roughness={0.4} />
      </mesh>
      {/* central post */}
      <mesh position={[0, 0.95, 0]} castShadow>
        <cylinderGeometry args={[0.028, 0.034, 1.78, 10]} />
        <meshStandardMaterial color={PALETTE.woodDark} roughness={0.7} />
      </mesh>
      {/* decorative cap finial */}
      <mesh position={[0, 1.88, 0]} castShadow>
        <sphereGeometry args={[0.055, 12, 10]} />
        <meshStandardMaterial color={PALETTE.brass} metalness={0.7} roughness={0.3} />
      </mesh>
      {/* four brass hooks near the top */}
      {[0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2].map((a, i) => (
        <group key={`hook-${i}`} position={[Math.cos(a) * 0.03, 1.72, Math.sin(a) * 0.03]}>
          <mesh rotation={[0, -a, -Math.PI / 3]} castShadow>
            <cylinderGeometry args={[0.012, 0.012, 0.16, 8]} />
            <meshStandardMaterial color={PALETTE.brass} metalness={0.75} roughness={0.25} />
          </mesh>
          <mesh position={[Math.cos(a) * 0.075, 0.08, Math.sin(a) * 0.075]}>
            <sphereGeometry args={[0.018, 10, 8]} />
            <meshStandardMaterial color={PALETTE.brass} metalness={0.75} roughness={0.25} />
          </mesh>
        </group>
      ))}
      {/* hung coats — each has a shoulder "hanger" cap and a body that
          tapers toward the hem, facing outward from the post */}
      {COATS.map((coat, i) => {
        const cx = Math.cos(coat.angle) * 0.22;
        const cz = Math.sin(coat.angle) * 0.22;
        return (
          <group key={`coat-${i}`} position={[cx, 1.55, cz]} rotation={[0, -coat.angle + Math.PI / 2, 0]}>
            {/* shoulders — flat disc on top of the coat */}
            <mesh position={[0, 0.1, 0]} castShadow>
              <cylinderGeometry args={[coat.width * 0.55, coat.width * 0.4, 0.06, 10]} />
              <meshStandardMaterial color={coat.shoulder} roughness={0.82} />
            </mesh>
            {/* body — tapered box, slightly splayed at the hem */}
            <mesh position={[0, -coat.height / 2 + 0.05, 0.02]} castShadow>
              <boxGeometry args={[coat.width, coat.height, 0.12]} />
              <meshStandardMaterial color={coat.color} roughness={0.9} />
            </mesh>
            {/* buttons or seam line down the front */}
            <mesh position={[0, -coat.height / 2 + 0.1, 0.08]}>
              <boxGeometry args={[0.01, coat.height * 0.75, 0.002]} />
              <meshStandardMaterial color="#2a2520" roughness={0.5} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

/** Anatomical teaching skeleton on a wheeled stand. Full-height human
 *  silhouette assembled from simple primitives — reads as a classroom
 *  skeleton, not a horror prop. */
function Skeleton({
  position,
  rotationY = 0,
  scale = 1,
}: {
  position: [number, number, number];
  rotationY?: number;
  scale?: number;
}) {
  const BONE = '#f4ecd8';
  const BONE_SHADOW = '#d4caa8';
  return (
    <group position={position} rotation={[0, rotationY, 0]} scale={scale}>
      {/* wheeled base — dark disc + 4 casters */}
      <mesh position={[0, 0.04, 0]} castShadow>
        <cylinderGeometry args={[0.28, 0.3, 0.06, 20]} />
        <meshStandardMaterial color="#2a2a2a" metalness={0.4} roughness={0.55} />
      </mesh>
      {([[-0.2, 0], [0.2, 0], [0, -0.2], [0, 0.2]] as const).map(([dx, dz], i) => (
        <mesh key={`caster-${i}`} position={[dx, 0.03, dz]}>
          <sphereGeometry args={[0.03, 8, 6]} />
          <meshStandardMaterial color="#1a1a1a" metalness={0.5} roughness={0.4} />
        </mesh>
      ))}
      {/* vertical support pole */}
      <mesh position={[0, 0.95, -0.05]} castShadow>
        <cylinderGeometry args={[0.018, 0.02, 1.82, 10]} />
        <meshStandardMaterial color="#6a6a6a" metalness={0.5} roughness={0.4} />
      </mesh>
      {/* cranial hook — the pole bends over into a hook that suspends the
          skull. A small bracket up top. */}
      <mesh position={[0, 1.87, -0.025]} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <torusGeometry args={[0.03, 0.01, 8, 10, Math.PI]} />
        <meshStandardMaterial color="#6a6a6a" metalness={0.5} roughness={0.4} />
      </mesh>

      {/* ===== Skull ===== */}
      <group position={[0, 1.75, 0]}>
        {/* cranium — slightly ovoid using scale on the mesh */}
        <mesh castShadow scale={[1, 1.08, 0.95]}>
          <sphereGeometry args={[0.12, 24, 20]} />
          <meshStandardMaterial color={BONE} roughness={0.55} />
        </mesh>
        {/* brow ridge — subtle band above the eyes */}
        <mesh position={[0, 0.03, 0.095]} rotation={[0, 0, 0]} castShadow>
          <boxGeometry args={[0.16, 0.02, 0.03]} />
          <meshStandardMaterial color={BONE_SHADOW} roughness={0.65} />
        </mesh>
        {/* cheekbones (zygomatic) */}
        {[-0.07, 0.07].map((dx, i) => (
          <mesh key={`zyg-${i}`} position={[dx, -0.03, 0.085]} castShadow>
            <sphereGeometry args={[0.028, 10, 8]} />
            <meshStandardMaterial color={BONE} roughness={0.6} />
          </mesh>
        ))}
        {/* upper jaw (maxilla) — narrower wedge */}
        <mesh position={[0, -0.08, 0.03]} castShadow>
          <boxGeometry args={[0.14, 0.04, 0.14]} />
          <meshStandardMaterial color={BONE} roughness={0.6} />
        </mesh>
        {/* lower jaw (mandible) — slightly wider, hangs under */}
        <mesh position={[0, -0.125, 0.025]} castShadow>
          <boxGeometry args={[0.15, 0.035, 0.13]} />
          <meshStandardMaterial color={BONE_SHADOW} roughness={0.65} />
        </mesh>
        {/* eye sockets — deeper ovals */}
        {[-0.045, 0.045].map((dx, i) => (
          <mesh key={`eye-${i}`} position={[dx, 0.005, 0.108]} scale={[1.1, 1, 1]}>
            <sphereGeometry args={[0.025, 12, 10]} />
            <meshStandardMaterial color="#0e0a08" />
          </mesh>
        ))}
        {/* nasal aperture (upside-down triangle) */}
        <mesh position={[0, -0.045, 0.113]} rotation={[0, 0, Math.PI]}>
          <coneGeometry args={[0.016, 0.048, 3]} />
          <meshStandardMaterial color="#0e0a08" />
        </mesh>
        {/* teeth — strip of small blocks, visible along mandible */}
        {[-0.036, -0.012, 0.012, 0.036].map((dx, i) => (
          <mesh key={`tooth-${i}`} position={[dx, -0.107, 0.088]}>
            <boxGeometry args={[0.016, 0.018, 0.006]} />
            <meshStandardMaterial color="#fbf3dc" />
          </mesh>
        ))}
      </group>

      {/* ===== Cervical vertebrae — neck between skull and thorax ===== */}
      {[0, 1, 2, 3].map((i) => {
        const y = 1.545 + i * 0.028;
        return (
          <mesh key={`cerv-${i}`} position={[0, y, 0]} castShadow>
            <cylinderGeometry args={[0.026, 0.028, 0.022, 10]} />
            <meshStandardMaterial color={BONE} roughness={0.65} />
          </mesh>
        );
      })}

      {/* ===== Clavicles (collarbones) ===== */}
      {[-1, 1].map((side, i) => (
        <mesh
          key={`clav-${i}`}
          position={[side * 0.1, 1.52, 0.08]}
          rotation={[0, side * -0.15, Math.PI / 2]}
          castShadow
        >
          <cylinderGeometry args={[0.012, 0.014, 0.2, 10]} />
          <meshStandardMaterial color={BONE} roughness={0.6} />
        </mesh>
      ))}

      {/* ===== Spine — stacked vertebrae ===== */}
      {Array.from({ length: 10 }).map((_, i) => {
        const y = 1.0 + i * 0.055;
        return (
          <mesh key={`vert-${i}`} position={[0, y, 0]} castShadow>
            <cylinderGeometry args={[0.035 - i * 0.0015, 0.04 - i * 0.0015, 0.04, 10]} />
            <meshStandardMaterial color={BONE} roughness={0.65} />
          </mesh>
        );
      })}

      {/* ===== Ribcage — arcs on both sides ===== */}
      {[0, 1, 2, 3, 4, 5].map((i) => {
        const y = 1.15 + i * 0.07;
        const r = 0.18 - i * 0.008;
        return (
          <mesh key={`rib-${i}`} position={[0, y, 0.005]} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[r, 0.012, 6, 18, Math.PI]} />
            <meshStandardMaterial color={BONE_SHADOW} roughness={0.7} />
          </mesh>
        );
      })}
      {/* sternum */}
      <mesh position={[0, 1.35, 0.165]} castShadow>
        <boxGeometry args={[0.03, 0.34, 0.01]} />
        <meshStandardMaterial color={BONE} roughness={0.65} />
      </mesh>

      {/* ===== Pelvis ===== */}
      <mesh position={[0, 0.95, 0]} castShadow>
        <boxGeometry args={[0.28, 0.1, 0.14]} />
        <meshStandardMaterial color={BONE} roughness={0.65} />
      </mesh>
      <mesh position={[0, 0.9, 0]} castShadow>
        <cylinderGeometry args={[0.11, 0.09, 0.12, 16]} />
        <meshStandardMaterial color={BONE} roughness={0.65} />
      </mesh>

      {/* ===== Arms ===== */}
      {[-1, 1].map((side, i) => (
        <group key={`arm-${i}`} position={[side * 0.18, 1.5, 0]} rotation={[0, 0, side * -0.06]}>
          {/* shoulder joint */}
          <mesh castShadow>
            <sphereGeometry args={[0.04, 10, 8]} />
            <meshStandardMaterial color={BONE} roughness={0.65} />
          </mesh>
          {/* upper arm (humerus) */}
          <mesh position={[side * 0.03, -0.2, 0]} rotation={[0, 0, side * 0.1]} castShadow>
            <cylinderGeometry args={[0.018, 0.022, 0.36, 10]} />
            <meshStandardMaterial color={BONE} roughness={0.65} />
          </mesh>
          {/* elbow */}
          <mesh position={[side * 0.06, -0.4, 0]} castShadow>
            <sphereGeometry args={[0.028, 10, 8]} />
            <meshStandardMaterial color={BONE_SHADOW} roughness={0.7} />
          </mesh>
          {/* forearm */}
          <mesh position={[side * 0.08, -0.6, 0]} rotation={[0, 0, side * 0.06]} castShadow>
            <cylinderGeometry args={[0.016, 0.018, 0.34, 10]} />
            <meshStandardMaterial color={BONE} roughness={0.65} />
          </mesh>
          {/* hand — palm block + 4 finger bones */}
          <mesh position={[side * 0.1, -0.8, 0]} castShadow>
            <boxGeometry args={[0.06, 0.07, 0.02]} />
            <meshStandardMaterial color={BONE} roughness={0.65} />
          </mesh>
          {[-0.021, -0.007, 0.007, 0.021].map((fx, fi) => (
            <mesh key={`fin-${fi}`} position={[side * 0.1 + fx, -0.87, 0]} castShadow>
              <cylinderGeometry args={[0.005, 0.006, 0.06, 6]} />
              <meshStandardMaterial color={BONE} roughness={0.65} />
            </mesh>
          ))}
          {/* thumb */}
          <mesh
            position={[side * 0.1 + side * 0.03, -0.82, 0]}
            rotation={[0, 0, side * 0.6]}
            castShadow
          >
            <cylinderGeometry args={[0.005, 0.006, 0.04, 6]} />
            <meshStandardMaterial color={BONE} roughness={0.65} />
          </mesh>
        </group>
      ))}

      {/* ===== Legs ===== */}
      {[-1, 1].map((side, i) => (
        <group key={`leg-${i}`} position={[side * 0.07, 0.85, 0]}>
          {/* hip joint */}
          <mesh castShadow>
            <sphereGeometry args={[0.04, 10, 8]} />
            <meshStandardMaterial color={BONE} roughness={0.65} />
          </mesh>
          {/* thigh (femur) */}
          <mesh position={[0, -0.22, 0]} castShadow>
            <cylinderGeometry args={[0.022, 0.026, 0.42, 10]} />
            <meshStandardMaterial color={BONE} roughness={0.65} />
          </mesh>
          {/* knee */}
          <mesh position={[0, -0.44, 0]} castShadow>
            <sphereGeometry args={[0.032, 10, 8]} />
            <meshStandardMaterial color={BONE_SHADOW} roughness={0.7} />
          </mesh>
          {/* shin (tibia) */}
          <mesh position={[0, -0.66, 0]} castShadow>
            <cylinderGeometry args={[0.02, 0.024, 0.42, 10]} />
            <meshStandardMaterial color={BONE} roughness={0.65} />
          </mesh>
          {/* foot */}
          <mesh position={[0, -0.88, 0.04]} castShadow>
            <boxGeometry args={[0.07, 0.05, 0.18]} />
            <meshStandardMaterial color={BONE} roughness={0.65} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/** Classic examination couch — padded vinyl top, paper roll at the head,
 *  chrome/steel frame with casters, step at the foot. Radiates "real
 *  clinic" vibes without crowding the desk area. */
function ExamBed({ position, rotationY = 0 }: { position: [number, number, number]; rotationY?: number }) {
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      {/* chrome frame — rectangular tube around the cushion underside */}
      <mesh position={[0, 0.68, 0]} castShadow>
        <boxGeometry args={[0.78, 0.06, 1.9]} />
        <meshStandardMaterial color="#bcbcbc" metalness={0.8} roughness={0.25} />
      </mesh>
      {/* the four legs */}
      {([[-0.34, 0.85], [0.34, 0.85], [-0.34, -0.85], [0.34, -0.85]] as const).map(([lx, lz], i) => (
        <group key={`leg-${i}`}>
          <mesh position={[lx, 0.34, lz]} castShadow>
            <cylinderGeometry args={[0.022, 0.022, 0.68, 10]} />
            <meshStandardMaterial color="#9a9a9a" metalness={0.75} roughness={0.3} />
          </mesh>
          {/* caster wheel */}
          <mesh position={[lx, 0.03, lz]} castShadow>
            <sphereGeometry args={[0.04, 10, 8]} />
            <meshStandardMaterial color="#1a1a1a" metalness={0.45} roughness={0.45} />
          </mesh>
        </group>
      ))}
      {/* cross bars for rigidity */}
      {[-0.85, 0.85].map((lz, i) => (
        <mesh key={`cross-${i}`} position={[0, 0.22, lz]} castShadow>
          <boxGeometry args={[0.68, 0.018, 0.018]} />
          <meshStandardMaterial color="#9a9a9a" metalness={0.75} roughness={0.3} />
        </mesh>
      ))}
      {/* vinyl cushion — main body (dark teal, medical feel) */}
      <RoundedBox args={[0.74, 0.11, 1.84]} radius={0.04} smoothness={3} position={[0, 0.77, 0]} castShadow>
        <meshStandardMaterial color="#3a6a72" roughness={0.55} />
      </RoundedBox>
      {/* raised head section — a slight back-rest at the head end */}
      <RoundedBox
        args={[0.74, 0.11, 0.48]}
        radius={0.04}
        smoothness={3}
        position={[0, 0.88, -0.62]}
        rotation={[-0.22, 0, 0]}
        castShadow
      >
        <meshStandardMaterial color="#3a6a72" roughness={0.55} />
      </RoundedBox>
      {/* white paper roll stretched over the cushion — classic exam-table
          hygiene sheet. Renders as a thin brighter strip on top. */}
      <mesh position={[0, 0.832, 0]}>
        <boxGeometry args={[0.64, 0.002, 1.82]} />
        <meshStandardMaterial color="#fbf7ec" emissive="#ffffff" emissiveIntensity={0.15} roughness={0.85} />
      </mesh>
      {/* paper dispenser — a cylinder at the head where the roll feeds from */}
      <mesh position={[0, 0.95, -0.92]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <cylinderGeometry args={[0.06, 0.06, 0.66, 14]} />
        <meshStandardMaterial color="#fbf7ec" roughness={0.85} />
      </mesh>
      <mesh position={[0, 0.95, -0.92]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.061, 0.061, 0.7, 14]} />
        <meshStandardMaterial color="#e6dfd0" roughness={0.9} />
      </mesh>
      {/* pillow at the head of the bed */}
      <RoundedBox args={[0.5, 0.07, 0.28]} radius={0.04} smoothness={3} position={[0, 0.93, -0.72]} rotation={[-0.22, 0, 0]} castShadow>
        <meshStandardMaterial color="#fbf7ec" roughness={0.85} />
      </RoundedBox>
      {/* foot step */}
      <mesh position={[0, 0.16, 1.05]} castShadow>
        <boxGeometry args={[0.44, 0.04, 0.28]} />
        <meshStandardMaterial color="#4a4a4a" metalness={0.55} roughness={0.45} />
      </mesh>
      {/* step legs */}
      {([[-0.18, 0.95], [0.18, 0.95], [-0.18, 1.15], [0.18, 1.15]] as const).map(([lx, lz], i) => (
        <mesh key={`stepleg-${i}`} position={[lx, 0.08, lz]} castShadow>
          <cylinderGeometry args={[0.014, 0.014, 0.16, 8]} />
          <meshStandardMaterial color="#9a9a9a" metalness={0.7} />
        </mesh>
      ))}
    </group>
  );
}

/** Wall-mounted first-aid cabinet with a big green cross — a piece of
 *  real clinic signage for an otherwise bare wall. Thinner than the
 *  MedicineCabinet, no glass door. */
function FirstAidCabinet({ position, rotationY = 0 }: { position: [number, number, number]; rotationY?: number }) {
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      {/* body */}
      <mesh castShadow>
        <boxGeometry args={[0.58, 0.72, 0.18]} />
        <meshStandardMaterial color="#f7f4ea" roughness={0.7} />
      </mesh>
      {/* outer metal trim */}
      <mesh position={[0, 0, 0.0]}>
        <boxGeometry args={[0.6, 0.74, 0.12]} />
        <meshStandardMaterial color="#c4c4c4" metalness={0.5} roughness={0.4} />
      </mesh>
      {/* green cross */}
      <mesh position={[0, 0.04, 0.095]}>
        <boxGeometry args={[0.16, 0.04, 0.012]} />
        <meshStandardMaterial color="#2a9a4a" emissive="#2a9a4a" emissiveIntensity={0.3} />
      </mesh>
      <mesh position={[0, 0.04, 0.095]}>
        <boxGeometry args={[0.04, 0.16, 0.012]} />
        <meshStandardMaterial color="#2a9a4a" emissive="#2a9a4a" emissiveIntensity={0.3} />
      </mesh>
      {/* FIRST AID label */}
      <Text position={[0, -0.22, 0.095]} fontSize={0.04} color="#2a9a4a" anchorX="center" anchorY="middle" fontWeight={700}>
        FIRST AID
      </Text>
      {/* cabinet handle */}
      <mesh position={[0.22, -0.08, 0.098]} castShadow>
        <boxGeometry args={[0.03, 0.1, 0.018]} />
        <meshStandardMaterial color="#9a9a9a" metalness={0.75} roughness={0.3} />
      </mesh>
      {/* mounting bracket shadow */}
      <mesh position={[0, 0.3, -0.09]}>
        <boxGeometry args={[0.4, 0.04, 0.008]} />
        <meshStandardMaterial color="#8a8a8a" metalness={0.4} />
      </mesh>
    </group>
  );
}

/** Simple bulletin / information board — cork panel in a wood frame,
 *  with a few pinned papers for visual flavour. Fills dead wall space. */
function BulletinBoard({ position, rotationY = 0 }: { position: [number, number, number]; rotationY?: number }) {
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      {/* frame */}
      <mesh castShadow>
        <boxGeometry args={[1.2, 0.8, 0.04]} />
        <meshStandardMaterial color={PALETTE.woodDark} roughness={0.7} />
      </mesh>
      {/* cork panel */}
      <mesh position={[0, 0, 0.022]}>
        <planeGeometry args={[1.12, 0.72]} />
        <meshStandardMaterial color="#c89664" roughness={0.95} />
      </mesh>
      {/* pinned notes — three off-white rectangles at angles */}
      {[
        { x: -0.34, y: 0.14, w: 0.3, h: 0.22, rot: 0.04, color: '#fbf7ec' },
        { x: 0.15, y: 0.18, w: 0.28, h: 0.18, rot: -0.05, color: '#f7e88a' },
        { x: -0.18, y: -0.18, w: 0.32, h: 0.2, rot: 0.03, color: '#fbf7ec' },
        { x: 0.28, y: -0.16, w: 0.26, h: 0.22, rot: -0.02, color: '#e4d8c8' },
      ].map((p, i) => (
        <group key={`note-${i}`} position={[p.x, p.y, 0.025]} rotation={[0, 0, p.rot]}>
          <mesh>
            <planeGeometry args={[p.w, p.h]} />
            <meshStandardMaterial color={p.color} roughness={0.85} />
          </mesh>
          {/* pushpin */}
          <mesh position={[0, p.h / 2 - 0.02, 0.003]}>
            <sphereGeometry args={[0.01, 8, 6]} />
            <meshStandardMaterial color={PALETTE.accent} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/** Large rug under the exam area. The layers are separated vertically by a
 *  few millimetres each — otherwise they z-fight with the floor plane (and
 *  with each other), which paints as a flickering "loading/unloading" effect
 *  on the screen every frame as the GPU flips between which triangle wins
 *  the depth test. polygonOffset on the floor's neighbour prevents the same
 *  fight against the floor. */
function Rug({ position, size = [3.2, 4.0] as [number, number] }: { position: [number, number, number]; size?: [number, number] }) {
  return (
    <group position={position}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.012, 0]} receiveShadow>
        <planeGeometry args={size} />
        <meshStandardMaterial color="#9a6548" roughness={0.95} polygonOffset polygonOffsetFactor={-1} polygonOffsetUnits={-1} />
      </mesh>
      {/* inner accent stripe */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.018, 0]}>
        <planeGeometry args={[size[0] * 0.85, size[1] * 0.85]} />
        <meshStandardMaterial color="#b87856" roughness={0.95} polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.024, 0]}>
        <planeGeometry args={[size[0] * 0.7, size[1] * 0.7]} />
        <meshStandardMaterial color="#d6a078" roughness={0.95} polygonOffset polygonOffsetFactor={-3} polygonOffsetUnits={-3} />
      </mesh>
    </group>
  );
}

/** Small side table next to the patient chair. */
function SideTable({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      <mesh position={[0, 0.55, 0]} castShadow>
        <boxGeometry args={[0.48, 0.04, 0.36]} />
        <meshStandardMaterial color={PALETTE.wood} />
      </mesh>
      {[-0.2, 0.2].map((lx, i) =>
        [-0.14, 0.14].map((lz, j) => (
          <mesh key={`leg-${i}-${j}`} position={[lx, 0.275, lz]} castShadow>
            <boxGeometry args={[0.04, 0.55, 0.04]} />
            <meshStandardMaterial color={PALETTE.woodDark} />
          </mesh>
        ))
      )}
      {/* tissue box */}
      <mesh position={[-0.12, 0.62, 0]} castShadow>
        <boxGeometry args={[0.2, 0.11, 0.12]} />
        <meshStandardMaterial color="#ffffff" />
      </mesh>
      <mesh position={[-0.12, 0.68, 0]}>
        <boxGeometry args={[0.1, 0.02, 0.04]} />
        <meshStandardMaterial color="#ffeedd" />
      </mesh>
      {/* water glass */}
      <mesh position={[0.14, 0.615, 0]} castShadow>
        <cylinderGeometry args={[0.035, 0.035, 0.11, 12]} />
        <meshStandardMaterial color="#c8e0ea" transparent opacity={0.5} roughness={0.1} />
      </mesh>
      {/* magazine */}
      <mesh position={[0.08, 0.575, 0.1]} rotation={[-Math.PI / 2, 0, 0.1]}>
        <planeGeometry args={[0.18, 0.24]} />
        <meshStandardMaterial color="#b83c3c" />
      </mesh>
    </group>
  );
}

/** Pendant (hanging) light — ceiling canopy, straight cord, brass/enamel
 *  cone shade. Replaces the older articulated exam arm, which felt
 *  out-of-language with the rest of the furniture. */
function ExamLight({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      {/* ceiling canopy (disc on the ceiling) */}
      <mesh position={[0, 0.04, 0]} castShadow>
        <cylinderGeometry args={[0.08, 0.1, 0.04, 20]} />
        <meshStandardMaterial color={PALETTE.brass} metalness={0.7} roughness={0.35} />
      </mesh>
      {/* cord — thin, perfectly vertical */}
      <mesh position={[0, -0.5, 0]} castShadow>
        <cylinderGeometry args={[0.006, 0.006, 1.0, 6]} />
        <meshStandardMaterial color="#2a2a2a" />
      </mesh>
      {/* brass cap at the top of the shade */}
      <mesh position={[0, -0.98, 0]} castShadow>
        <cylinderGeometry args={[0.055, 0.04, 0.035, 20]} />
        <meshStandardMaterial color={PALETTE.brass} metalness={0.7} roughness={0.35} />
      </mesh>
      {/* enamelled cone shade — widens downward like a classic desk pendant */}
      <mesh position={[0, -1.12, 0]} castShadow>
        <cylinderGeometry args={[0.22, 0.1, 0.28, 24, 1, true]} />
        <meshStandardMaterial color="#eae1cf" roughness={0.55} side={THREE.DoubleSide} />
      </mesh>
      {/* inner glow disc — where the bulb "peeks" from under the shade */}
      <mesh position={[0, -1.255, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.2, 24]} />
        <meshStandardMaterial color="#fff1c4" emissive="#ffd98a" emissiveIntensity={1.4} toneMapped={false} />
      </mesh>
      {/* bulb hint */}
      <mesh position={[0, -1.18, 0]}>
        <sphereGeometry args={[0.035, 12, 12]} />
        <meshStandardMaterial color="#fff4d4" emissive="#ffe9a8" emissiveIntensity={2.2} toneMapped={false} />
      </mesh>
      <pointLight position={[0, -1.3, 0]} intensity={0.9} distance={4.5} color="#ffd98a" />
    </group>
  );
}

/** Water cooler in the corner. */
function WaterCooler({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      {/* base */}
      <mesh position={[0, 0.5, 0]} castShadow>
        <boxGeometry args={[0.34, 1.0, 0.34]} />
        <meshStandardMaterial color="#f0ebe1" />
      </mesh>
      {/* bottle holder */}
      <mesh position={[0, 1.1, 0]} castShadow>
        <cylinderGeometry args={[0.16, 0.18, 0.28, 14]} />
        <meshStandardMaterial color="#d4d4d4" metalness={0.3} />
      </mesh>
      {/* blue water bottle */}
      <mesh position={[0, 1.42, 0]} castShadow>
        <cylinderGeometry args={[0.13, 0.15, 0.44, 14]} />
        <meshStandardMaterial color="#88c4e0" transparent opacity={0.7} />
      </mesh>
      <mesh position={[0, 1.68, 0]} castShadow>
        <cylinderGeometry args={[0.06, 0.1, 0.08, 12]} />
        <meshStandardMaterial color="#3a5a9a" />
      </mesh>
      {/* tap */}
      <mesh position={[0, 0.7, 0.18]} castShadow>
        <boxGeometry args={[0.06, 0.04, 0.06]} />
        <meshStandardMaterial color={PALETTE.accent} />
      </mesh>
    </group>
  );
}

/** Canvas texture painted like an out-the-window view — blue sky,
 *  distant city skyline, a few clouds. Backs the window panes so the
 *  glass actually shows *something* beyond it. */
function makeWindowViewTexture(): CanvasTexture {
  const w = 512, h = 512;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  // sky gradient
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#88bce4');
  sky.addColorStop(0.55, '#b6d5ea');
  sky.addColorStop(1, '#e2ccaa');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  // sun glow
  const glow = ctx.createRadialGradient(w * 0.78, h * 0.3, 10, w * 0.78, h * 0.3, 180);
  glow.addColorStop(0, 'rgba(255,230,160,0.9)');
  glow.addColorStop(1, 'rgba(255,230,160,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);
  // clouds
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  const clouds: [number, number, number][] = [[120, 110, 60], [260, 80, 45], [380, 150, 55], [80, 200, 40]];
  for (const [cx, cy, cr] of clouds) {
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      ctx.arc(cx + Math.cos(a) * cr * 0.6, cy + Math.sin(a) * cr * 0.3, cr * 0.5, 0, Math.PI * 2);
    }
    ctx.fill();
  }
  // far mountains / hills
  ctx.fillStyle = '#8fa4b8';
  ctx.beginPath();
  ctx.moveTo(0, h * 0.62);
  for (let x = 0; x <= w; x += 30) {
    ctx.lineTo(x, h * 0.62 - Math.sin(x * 0.02) * 18 - Math.sin(x * 0.07) * 8);
  }
  ctx.lineTo(w, h); ctx.lineTo(0, h);
  ctx.fill();
  // city skyline
  ctx.fillStyle = '#5a6a7a';
  let bx = 0;
  while (bx < w) {
    const bw = 20 + Math.random() * 35;
    const bh = 40 + Math.random() * 120;
    ctx.fillRect(bx, h * 0.7 - bh, bw, bh);
    // windows
    ctx.fillStyle = '#e4c468';
    for (let wy = h * 0.7 - bh + 8; wy < h * 0.7 - 6; wy += 10) {
      for (let wx = bx + 4; wx < bx + bw - 4; wx += 8) {
        if (Math.random() > 0.55) ctx.fillRect(wx, wy, 3, 4);
      }
    }
    ctx.fillStyle = '#5a6a7a';
    bx += bw + 3;
  }
  // closer tree on the right
  ctx.fillStyle = '#3a5a3a';
  ctx.beginPath();
  ctx.arc(w * 0.85, h * 0.68, 60, 0, Math.PI * 2);
  ctx.arc(w * 0.92, h * 0.72, 45, 0, Math.PI * 2);
  ctx.arc(w * 0.8, h * 0.74, 50, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#4a3020';
  ctx.fillRect(w * 0.84, h * 0.75, 8, 60);
  // ground
  ctx.fillStyle = '#8a7a5a';
  ctx.fillRect(0, h * 0.78, w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Painted sky/skyline backdrop that sits BEYOND the left wall, visible
 *  through the window opening cut into it. Big enough to fill the view
 *  from any reasonable angle inside the exam room. Rendered emissive so
 *  it reads as daylight, not an interior surface. */
function OutdoorBackdrop() {
  const tex = useMemo(() => makeWindowViewTexture(), []);
  useEffect(() => () => tex.dispose(), [tex]);
  return (
    <group>
      {/* wide painted plane facing +x (into the room) */}
      <mesh position={[WORLD_LEFT_X - 0.6, WINDOW_CENTER_Y, WINDOW_CENTER_Z]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[5.5, 4.5]} />
        <meshStandardMaterial
          map={tex}
          emissive="#ffffff"
          emissiveMap={tex}
          emissiveIntensity={0.95}
          toneMapped={false}
          side={THREE.DoubleSide}
        />
      </mesh>
      {/* A faint ambient light colour at the window opening so anything the
          doctor/patient has facing the window picks up a touch of daylight. */}
      <pointLight
        position={[WORLD_LEFT_X + 0.4, WINDOW_CENTER_Y + 0.2, WINDOW_CENTER_Z]}
        intensity={0.35}
        distance={4.5}
        color="#ffd9a0"
      />
    </group>
  );
}

/** Window on the left wall with muntins, sill, and a painted view beyond
 *  the glass — blue sky, city skyline, a tree. The actual "sunlight" is
 *  still provided by the directional light in Lighting(). */
function Window({ position }: { position: [number, number, number] }) {
  return (
    <group position={position} rotation={[0, Math.PI / 2, 0]}>
      {/* HOLLOW frame — 4 edge boxes around the opening. The old version
          used a single filled RoundedBox which occluded the outdoor
          backdrop beyond the wall, so the "view" was invisible. Now the
          opening is genuinely open; <OutdoorBackdrop/> shows through. */}
      {/* top edge */}
      <mesh position={[0, 0.91, 0]} castShadow>
        <boxGeometry args={[1.7, 0.08, 0.08]} />
        <meshStandardMaterial color={PALETTE.wallTrim} roughness={0.55} />
      </mesh>
      {/* bottom edge */}
      <mesh position={[0, -0.91, 0]} castShadow>
        <boxGeometry args={[1.7, 0.08, 0.08]} />
        <meshStandardMaterial color={PALETTE.wallTrim} roughness={0.55} />
      </mesh>
      {/* left edge */}
      <mesh position={[-0.81, 0, 0]} castShadow>
        <boxGeometry args={[0.08, 1.74, 0.08]} />
        <meshStandardMaterial color={PALETTE.wallTrim} roughness={0.55} />
      </mesh>
      {/* right edge */}
      <mesh position={[0.81, 0, 0]} castShadow>
        <boxGeometry args={[0.08, 1.74, 0.08]} />
        <meshStandardMaterial color={PALETTE.wallTrim} roughness={0.55} />
      </mesh>
      {/* two glazing panes — almost fully transparent with a thin reflective
          sheen so the outdoor backdrop reads clearly through them. */}
      {[-0.39, 0.39].map((dx, i) => (
        <mesh key={`pane-${i}`} position={[dx, 0, 0.02]}>
          <planeGeometry args={[0.74, 1.6]} />
          <meshStandardMaterial
            color="#c8dcea"
            transparent
            opacity={0.08}
            roughness={0.05}
            metalness={0.3}
            toneMapped={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}
      {/* horizontal muntin */}
      <mesh position={[0, 0, 0.028]}>
        <boxGeometry args={[1.5, 0.05, 0.02]} />
        <meshStandardMaterial color={PALETTE.wallTrim} />
      </mesh>
      {/* vertical muntin */}
      <mesh position={[0, 0, 0.028]}>
        <boxGeometry args={[0.05, 1.7, 0.02]} />
        <meshStandardMaterial color={PALETTE.wallTrim} />
      </mesh>
      {/* sill — sits on the inside of the wall */}
      <RoundedBox args={[1.85, 0.08, 0.24]} radius={0.02} smoothness={2} position={[0, -1.0, 0.08]} castShadow>
        <meshStandardMaterial color={PALETTE.wallTrim} roughness={0.5} />
      </RoundedBox>
      {/* little plant on the sill */}
      <group position={[0.6, -0.88, 0.06]}>
        <mesh castShadow>
          <cylinderGeometry args={[0.09, 0.08, 0.12, 14]} />
          <meshStandardMaterial color={PALETTE.pot} roughness={0.85} />
        </mesh>
        <mesh position={[0, 0.15, 0]} castShadow>
          <sphereGeometry args={[0.13, 12, 10]} />
          <meshStandardMaterial color={PALETTE.plant} roughness={0.85} />
        </mesh>
        <mesh position={[0.08, 0.2, 0.04]} castShadow>
          <sphereGeometry args={[0.07, 10, 8]} />
          <meshStandardMaterial color="#6a9454" roughness={0.85} />
        </mesh>
      </group>
      {/* curtain rod + curtains */}
      <mesh position={[0, 1.02, 0.08]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <cylinderGeometry args={[0.02, 0.02, 2.0, 10]} />
        <meshStandardMaterial color={PALETTE.brass} metalness={0.75} roughness={0.3} />
      </mesh>
      {[-0.98, 0.98].map((dx, i) => (
        <mesh key={`curtain-${i}`} position={[dx, -0.05, 0.07]} castShadow>
          <boxGeometry args={[0.18, 1.9, 0.08]} />
          <meshStandardMaterial color={PALETTE.rugRed} roughness={0.95} />
        </mesh>
      ))}
    </group>
  );
}

/** Framed photograph — warm personal touch on the wall. Canvas texture is
 *  a simple "scene" (horizon + sun) so it reads as a picture, not a poster. */
function FramedPhoto({
  position,
  rotationY = 0,
  tone = 'sunset',
}: {
  position: [number, number, number];
  rotationY?: number;
  tone?: 'sunset' | 'mountain' | 'sea';
}) {
  const texture = useMemo(() => {
    const w = 256, h = 192;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d')!;
    if (tone === 'sunset') {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#f3a85a'); g.addColorStop(0.5, '#e67a3a'); g.addColorStop(1, '#4a2a48');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#f8d488';
      ctx.beginPath(); ctx.arc(w * 0.7, h * 0.55, 22, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#2a1a1a';
      ctx.fillRect(0, h * 0.78, w, h * 0.22);
    } else if (tone === 'mountain') {
      ctx.fillStyle = '#bcd8e8'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#8ca898';
      ctx.beginPath(); ctx.moveTo(0, h); ctx.lineTo(w * 0.25, h * 0.3); ctx.lineTo(w * 0.55, h); ctx.fill();
      ctx.fillStyle = '#6a8a7a';
      ctx.beginPath(); ctx.moveTo(w * 0.35, h); ctx.lineTo(w * 0.65, h * 0.15); ctx.lineTo(w, h); ctx.fill();
      ctx.fillStyle = '#4a6a5a';
      ctx.fillRect(0, h * 0.85, w, h * 0.15);
    } else {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#88bcd8'); g.addColorStop(0.55, '#4a82a8'); g.addColorStop(1, '#2a5070');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#e8c884';
      ctx.fillRect(0, h * 0.82, w, h * 0.18);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, [tone]);
  useEffect(() => () => texture.dispose(), [texture]);
  const w = 0.5, h = 0.38;
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <mesh castShadow>
        <boxGeometry args={[w + 0.04, h + 0.04, 0.03]} />
        <meshStandardMaterial color={PALETTE.woodDark} roughness={0.5} />
      </mesh>
      <mesh position={[0, 0, 0.018]}>
        <planeGeometry args={[w, h]} />
        <meshStandardMaterial map={texture} />
      </mesh>
    </group>
  );
}

/** Tall corner plant — fiddle-leaf-ish silhouette. Adds vertical interest. */
function CornerPlant({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      {/* wicker basket */}
      <mesh position={[0, 0.28, 0]} castShadow>
        <cylinderGeometry args={[0.28, 0.22, 0.56, 18]} />
        <meshStandardMaterial color={PALETTE.wood} roughness={0.95} />
      </mesh>
      {/* rim */}
      <mesh position={[0, 0.56, 0]}>
        <torusGeometry args={[0.28, 0.03, 8, 24]} />
        <meshStandardMaterial color={PALETTE.woodDark} roughness={0.8} />
      </mesh>
      {/* trunk */}
      <mesh position={[0, 1.05, 0]} castShadow>
        <cylinderGeometry args={[0.03, 0.04, 1.0, 8]} />
        <meshStandardMaterial color={PALETTE.woodDark} roughness={0.8} />
      </mesh>
      {/* big stacked leaves */}
      {[
        [0, 1.1, 0, 0.28],
        [0.18, 1.35, 0.08, 0.24],
        [-0.18, 1.5, -0.05, 0.26],
        [0.1, 1.7, -0.12, 0.22],
        [-0.12, 1.85, 0.08, 0.2],
        [0.05, 2.05, 0, 0.18],
      ].map(([x, y, z, r], i) => (
        <mesh key={`leaf-${i}`} position={[x, y, z]} castShadow>
          <sphereGeometry args={[r, 10, 8]} />
          <meshStandardMaterial color={i % 2 ? PALETTE.plant : '#6a9454'} roughness={0.9} />
        </mesh>
      ))}
    </group>
  );
}

/** Stack of books on the floor — "the doctor who reads" vibe. */
function FloorBooks({ position }: { position: [number, number, number] }) {
  const colors = ['#8a3628', '#2a5a8a', '#c8944a', '#4a7a4a'];
  return (
    <group position={position}>
      {colors.map((c, i) => (
        <mesh key={i} position={[i * 0.01 - 0.02, 0.035 + i * 0.055, i * 0.008]} rotation={[0, i * 0.06, 0]} castShadow>
          <boxGeometry args={[0.26, 0.05, 0.34]} />
          <meshStandardMaterial color={c} roughness={0.85} />
        </mesh>
      ))}
    </group>
  );
}

function SpecialtyPoster({
  position,
  rotationY = 0,
  title,
  subtitle,
}: {
  position: [number, number, number];
  rotationY?: number;
  title: string;
  subtitle?: string;
}) {
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <mesh>
        <boxGeometry args={[2.4, 1.0, 0.05]} />
        <meshStandardMaterial color="#fbf7ec" />
      </mesh>
      <mesh position={[0, 0, 0.03]}>
        <boxGeometry args={[2.2, 0.82, 0.01]} />
        <meshStandardMaterial color={PALETTE.accent} emissive={PALETTE.accent} emissiveIntensity={0.35} />
      </mesh>
      <Text position={[0, 0.15, 0.04]} fontSize={0.22} color="#fff8ec" anchorX="center" anchorY="middle" fontWeight={700}>
        {title}
      </Text>
      <Text position={[0, -0.18, 0.04]} fontSize={0.11} color="#fff8ec" anchorX="center" anchorY="middle">
        {subtitle ?? 'POLYCLINIC'}
      </Text>
    </group>
  );
}

function CorridorSign({
  position,
  rotationY = 0,
  title,
}: {
  position: [number, number, number];
  rotationY?: number;
  title: string;
}) {
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <mesh>
        <boxGeometry args={[1.4, 0.45, 0.05]} />
        <meshStandardMaterial color={PALETTE.trim} emissive={PALETTE.trim} emissiveIntensity={0.45} />
      </mesh>
      <Text position={[0, 0, 0.04]} fontSize={0.16} color="#fff8ec" anchorX="center" anchorY="middle" fontWeight={700}>
        {title}
      </Text>
    </group>
  );
}

function DoorLeaf({ open, side }: { open: boolean; side: 'left' | 'right' }) {
  const ref = useRef<Group>(null);
  const closedX = side === 'left' ? -DOOR_HALF_WIDTH * 0.5 : DOOR_HALF_WIDTH * 0.5;
  const openX = side === 'left' ? -DOOR_HALF_WIDTH * 1.4 : DOOR_HALF_WIDTH * 1.4;
  useFrame((_, dt) => {
    if (!ref.current) return;
    const target = open ? openX : closedX;
    ref.current.position.x += (target - ref.current.position.x) * Math.min(1, dt * 4);
  });
  const leafW = DOOR_HALF_WIDTH;
  // Sign of the "outer" side (toward the door jamb) — handles go on the
  // inner side (toward the gap between the two leaves).
  const innerSign = side === 'left' ? 1 : -1;
  const innerX = innerSign * (leafW / 2 - 0.08);
  const DOOR_COLOR = '#c89c6a';
  const PANEL_COLOR = '#a67a48';
  return (
    <group ref={ref} position={[closedX, 1.0, ROOM_FRONT_Z]}>
      {/* door slab */}
      <mesh castShadow>
        <boxGeometry args={[leafW, 2.0, 0.06]} />
        <meshStandardMaterial color={DOOR_COLOR} roughness={0.7} />
      </mesh>
      {/* top window — frosted glass pane */}
      <mesh position={[0, 0.55, 0.031]}>
        <planeGeometry args={[leafW - 0.2, 0.55]} />
        <meshStandardMaterial
          color="#c0d8e4"
          transparent
          opacity={0.55}
          roughness={0.35}
          metalness={0.1}
        />
      </mesh>
      {/* window frame — thin border around the pane */}
      {[-1, 1].map((sd) => (
        <mesh key={`wf-v-${sd}`} position={[sd * (leafW / 2 - 0.1), 0.55, 0.032]}>
          <boxGeometry args={[0.02, 0.58, 0.006]} />
          <meshStandardMaterial color={PANEL_COLOR} />
        </mesh>
      ))}
      {[-1, 1].map((sd) => (
        <mesh key={`wf-h-${sd}`} position={[0, 0.55 + sd * 0.285, 0.032]}>
          <boxGeometry args={[leafW - 0.2, 0.02, 0.006]} />
          <meshStandardMaterial color={PANEL_COLOR} />
        </mesh>
      ))}
      {/* lower recessed panel — darker inset rectangle */}
      <mesh position={[0, -0.4, 0.031]}>
        <boxGeometry args={[leafW - 0.2, 0.7, 0.005]} />
        <meshStandardMaterial color={PANEL_COLOR} roughness={0.75} />
      </mesh>
      {/* panel beveled edge */}
      <mesh position={[0, -0.4, 0.034]}>
        <boxGeometry args={[leafW - 0.24, 0.66, 0.004]} />
        <meshStandardMaterial color={DOOR_COLOR} roughness={0.7} />
      </mesh>
      {/* door handle — lever on the inner edge */}
      <group position={[innerX, -0.05, 0.04]}>
        {/* back plate */}
        <mesh>
          <boxGeometry args={[0.05, 0.14, 0.012]} />
          <meshStandardMaterial color="#8a8580" metalness={0.7} roughness={0.3} />
        </mesh>
        {/* lever arm — horizontal, pointing toward the centre gap */}
        <mesh position={[-innerSign * 0.05, 0, 0.015]} rotation={[0, 0, 0]} castShadow>
          <cylinderGeometry args={[0.012, 0.012, 0.1, 10]} />
          <meshStandardMaterial color="#c0c0c0" metalness={0.8} roughness={0.25} />
        </mesh>
        {/* lever tip (rotated so cylinder points sideways) */}
        <mesh
          position={[-innerSign * 0.1, 0, 0.02]}
          rotation={[0, 0, Math.PI / 2]}
          castShadow
        >
          <cylinderGeometry args={[0.014, 0.014, 0.03, 10]} />
          <meshStandardMaterial color="#c0c0c0" metalness={0.8} roughness={0.25} />
        </mesh>
      </group>
      {/* kick plate at the bottom */}
      <mesh position={[0, -0.9, 0.032]}>
        <boxGeometry args={[leafW - 0.05, 0.15, 0.006]} />
        <meshStandardMaterial color="#8a8580" metalness={0.5} roughness={0.5} />
      </mesh>
    </group>
  );
}

function DoorFrame() {
  return (
    <group position={[DOOR_X, 0, ROOM_FRONT_Z]}>
      <mesh position={[0, 2.1, 0]} castShadow>
        <boxGeometry args={[2.0, 0.14, 0.36]} />
        <meshStandardMaterial color={PALETTE.accent} emissive={PALETTE.accent} emissiveIntensity={0.45} />
      </mesh>
      <mesh position={[-1.0, 1.0, 0]} castShadow>
        <boxGeometry args={[0.1, 2.0, 0.36]} />
        <meshStandardMaterial color={PALETTE.accent} />
      </mesh>
      <mesh position={[1.0, 1.0, 0]} castShadow>
        <boxGeometry args={[0.1, 2.0, 0.36]} />
        <meshStandardMaterial color={PALETTE.accent} />
      </mesh>
    </group>
  );
}

/** The seated doctor doesn't walk around, so the "interactable" idea boils
 *  down to: E/T acts on the patient when one is seated, otherwise E opens
 *  the archive at the desk. We register EXACTLY ONE interactable at a time
 *  so the player's "closest active" logic never picks the wrong one. */
function SeatedDoctorInteractable({ patientName }: { patientName: string | null }) {
  useEffect(() => {
    if (patientName) {
      interactionBus.register({
        id: 'polyclinic-active-patient',
        position: PATIENT_CHAIR_POS,
        radius: 100,
        prompt: `E — 入组沟通评估   ·   T — 与 ${patientName} 对话`,
        kind: 'bed',
        bedIndex: POLYCLINIC_BED_INDEX,
      });
      return () => interactionBus.unregister('polyclinic-active-patient');
    }
    // No patient — expose the archive instead.
    interactionBus.register({
      id: 'polyclinic-archive',
      position: DESK_POS,
      radius: 100,
      prompt: 'E — 入组沟通记录',
      kind: 'desk',
    });
    return () => interactionBus.unregister('polyclinic-archive');
  }, [patientName]);
  return null;
}

/** Map a patient's severity + chief complaint to a facial expression for
 *  the stylized character. Case data doesn't carry an explicit expression
 *  field, so we scan the complaint text for pain / fatigue / anxiety cues
 *  and fall back to severity. */
function deriveExpression(
  severity: 'critical' | 'urgent' | 'stable' | undefined,
  complaint: string | undefined,
): 'neutral' | 'pain' | 'anxious' | 'fatigued' {
  const c = (complaint ?? '').toLowerCase();
  const hasPainWord = /pain|ache|aching|agon|severe|sharp|throbbing|cramp|burning|stabbing|chest\s*pain/.test(
    c,
  );
  const hasFatigueWord = /tired|exhaust|fatigue|weak|weary|drained|worn[-\s]?out|lethargic|sleepy/.test(
    c,
  );
  const hasAnxietyWord = /anxious|panic|palpitation|scared|worried|racing\s*heart/.test(
    c,
  );
  if (severity === 'critical' || hasPainWord) return 'pain';
  if (hasFatigueWord) return 'fatigued';
  if (severity === 'urgent' || hasAnxietyWord) return 'anxious';
  return 'neutral';
}

/** Walks the patient in from the corridor to the patient chair, then hides
 *  itself so the seated figure takes over. On patient clear, plays walk-out. */
function WalkingPatient({
  hasPatient,
  patientKey,
  age,
  gender,
  caseId,
  severity,
  complaint,
  onSeatedChange,
}: {
  hasPatient: boolean;
  patientKey: string | null;
  age?: number;
  gender?: 'M' | 'F';
  /** Stable string used as seed for the Avatar's GLB pool pick, so the
   *  same patient always loads the same underlying rig. */
  caseId?: string;
  severity?: 'critical' | 'urgent' | 'stable';
  complaint?: string;
  /** Fires true when the walk-in animation finishes and the patient has
   *  reached the chair; false again when a new walk-in starts or the
   *  patient walks out. The parent uses this to hide the seated figure
   *  until the walking figure is no longer on screen. */
  onSeatedChange?: (seated: boolean) => void;
}) {
  const groupRef = useRef<Group | null>(null);
  const [phase, setPhase] = useState<'walk-in' | 'seated' | 'walk-out' | 'gone'>('gone');
  const progressRef = useRef(0);
  const WALK_DURATION_S = 4.0;

  const prevKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (hasPatient && patientKey && patientKey !== prevKeyRef.current) {
      progressRef.current = 0;
      setPhase('walk-in');
      onSeatedChange?.(false);
      prevKeyRef.current = patientKey;
    } else if (!hasPatient && prevKeyRef.current) {
      progressRef.current = 0;
      setPhase('walk-out');
      onSeatedChange?.(false);
      prevKeyRef.current = null;
    }
  }, [hasPatient, patientKey, onSeatedChange]);

  const walkCycleRef = useRef(0);
  useFrame((_, dt) => {
    const g = groupRef.current;
    if (!g) return;
    if (phase === 'walk-in' || phase === 'walk-out') {
      walkCycleRef.current = (walkCycleRef.current + dt * 1.3) % 1;
    }
    if (phase === 'walk-in') {
      progressRef.current = Math.min(1, progressRef.current + dt / WALK_DURATION_S);
      const t = progressRef.current;
      g.position.x = PATIENT_SPAWN[0] + (PATIENT_AT_SEAT[0] - PATIENT_SPAWN[0]) * t;
      g.position.z = PATIENT_SPAWN[2] + (PATIENT_AT_SEAT[2] - PATIENT_SPAWN[2]) * t;
      const dx = PATIENT_AT_SEAT[0] - PATIENT_SPAWN[0];
      const dz = PATIENT_AT_SEAT[2] - PATIENT_SPAWN[2];
      g.rotation.y = Math.atan2(dx, dz);
      g.position.y = 0;
      if (t >= 1) {
        setPhase('seated');
        onSeatedChange?.(true);
        // Snap exactly to chair position and face the doctor (−z).
        g.position.set(PATIENT_AT_SEAT[0], 0, PATIENT_AT_SEAT[2]);
        g.rotation.y = Math.PI;
      }
    } else if (phase === 'walk-out') {
      progressRef.current = Math.min(1, progressRef.current + dt / WALK_DURATION_S);
      const t = progressRef.current;
      g.position.x = PATIENT_AT_SEAT[0] + (PATIENT_SPAWN[0] - PATIENT_AT_SEAT[0]) * t;
      g.position.z = PATIENT_AT_SEAT[2] + (PATIENT_SPAWN[2] - PATIENT_AT_SEAT[2]) * t;
      const dx = PATIENT_SPAWN[0] - PATIENT_AT_SEAT[0];
      const dz = PATIENT_SPAWN[2] - PATIENT_AT_SEAT[2];
      g.rotation.y = Math.atan2(dx, dz);
      g.position.y = 0;
      if (t >= 1) setPhase('gone');
    }
  });

  if (phase === 'gone') return null;

  const patientAge = age ?? 35;
  const patientGender = gender ?? 'M';
  const charPose: 'walking' | 'sitting' =
    phase === 'seated' ? 'sitting' : 'walking';
  const expression = deriveExpression(severity, complaint);
  // Pediatric patients arrive with an accompanying adult. The companion
  // walks alongside the child, then stands beside the chair while the
  // child sits. Gender comes from the SAME helper the voice persona uses
  // (`parentGenderForId`) so the visible parent and the speaking parent
  // are always the same person.
  const isChild = patientAge < 14;
  const parentSeed = isChild && caseId ? `${caseId}-parent` : null;
  const parentGender: 'M' | 'F' = caseId ? parentGenderForId(caseId) : 'F';
  const parentPose: 'walking' | 'standing' =
    charPose === 'sitting' ? 'standing' : 'walking';
  return (
    <group ref={groupRef as React.MutableRefObject<Group>} position={PATIENT_SPAWN}>
      <StylizedCharacter
        pose={charPose}
        walkCycle={walkCycleRef.current}
        age={patientAge}
        gender={patientGender}
        seed={caseId}
        expression={expression}
        lookAtCamera={charPose === 'sitting'}
      />
      {parentSeed && (
        // Parent's local +x maps to world −x after the group's seated
        // rotationY=π, which puts the parent on the camera's RIGHT — a
        // visible spot next to the chair from the doctor's POV.
        <StylizedCharacter
          pose={parentPose}
          walkCycle={walkCycleRef.current}
          age={38}
          gender={parentGender}
          seed={parentSeed}
          position={[0.7, 0, 0.05]}
          expression="neutral"
          lookAtCamera={parentPose === 'standing'}
        />
      )}
    </group>
  );
}

// ───────── Main scene ─────────

export function Polyclinic({
  voiceActive = false,
  onCloseVoice,
}: {
  voiceActive?: boolean;
  onCloseVoice?: () => void;
} = {}) {
  const state = useGameState();
  const clinicId = state.polyclinic.clinic;
  const patient = state.polyclinic.patient;
  const clinicLabel = CLINIC_LABELS[clinicId];

  const [doorOpen, setDoorOpen] = useState(false);
  const prevPatientRef = useRef<typeof patient>(null);
  useEffect(() => {
    const prev = prevPatientRef.current;
    if (patient && !prev) {
      setDoorOpen(true);
      const t = window.setTimeout(() => setDoorOpen(false), 5500);
      prevPatientRef.current = patient;
      return () => window.clearTimeout(t);
    }
    if (!patient && prev) {
      setDoorOpen(true);
      const t = window.setTimeout(() => setDoorOpen(false), 5500);
      prevPatientRef.current = null;
      return () => window.clearTimeout(t);
    }
    prevPatientRef.current = patient;
  }, [patient]);

  const patientKey = useMemo(() => {
    if (!patient) return null;
    return `${patient.case.id}-${patient.arrivedAt}`;
  }, [patient]);

  // The GLB avatar renders throughout walk-in → seated → walk-out via
  // WalkingPatient below; no separate seated-figure gate is needed.

  return (
    <>
      <Lighting />
      <Floor />

      {/* Outer walls */}
      <Wall position={[OUTER_CENTER_X, 1.5, WORLD_BACK_Z]} args={[OUTER_WIDTH, 3, 0.3]} />
      <Wall position={[OUTER_CENTER_X, 1.5, CORRIDOR_FRONT_Z]} args={[OUTER_WIDTH, 3, 0.3]} />
      {/* Left wall — split into four pieces so the window is a real hole
           (wall below + above + z-before + z-after the opening). The
           collider stays a single slab — see POLYCLINIC_COLLIDERS. */}
      <Wall
        position={[WORLD_LEFT_X, WINDOW_Y_MIN / 2, OUTER_CENTER_Z]}
        args={[0.3, WINDOW_Y_MIN, OUTER_DEPTH]}
      />
      <Wall
        position={[WORLD_LEFT_X, (WINDOW_Y_MAX + 3) / 2, OUTER_CENTER_Z]}
        args={[0.3, 3 - WINDOW_Y_MAX, OUTER_DEPTH]}
      />
      <Wall
        position={[WORLD_LEFT_X, WINDOW_CENTER_Y, (WORLD_BACK_Z + WINDOW_Z_MIN) / 2]}
        args={[0.3, WINDOW_Y_MAX - WINDOW_Y_MIN, WINDOW_Z_MIN - WORLD_BACK_Z]}
      />
      <Wall
        position={[WORLD_LEFT_X, WINDOW_CENTER_Y, (WINDOW_Z_MAX + CORRIDOR_FRONT_Z) / 2]}
        args={[0.3, WINDOW_Y_MAX - WINDOW_Y_MIN, CORRIDOR_FRONT_Z - WINDOW_Z_MAX]}
      />
      {/* Outdoor view backdrop — sits OUTSIDE the left wall and faces
           into the room so the window shows real sky/skyline through
           the glass panes. */}
      <OutdoorBackdrop />
      <Wall position={[WORLD_RIGHT_X, 1.5, OUTER_CENTER_Z]} args={[0.3, 3, OUTER_DEPTH]} />

      {/* Exam-room front wall (with door opening) */}
      {FRONT_WALL_SEGMENTS.map((seg, i) => (
        <Wall key={`fw-${i}`} position={[seg.center, 1.5, ROOM_FRONT_Z]} args={[seg.length, 3, 0.3]} />
      ))}
      {/* Lintel — the wall section ABOVE the door opening. Without this
          there's a visible rectangular hole between the door frame header
          (top at y≈2.17) and the ceiling at y=3.0. */}
      <Wall
        position={[DOOR_X, (2.17 + 3.0) / 2, ROOM_FRONT_Z]}
        args={[DOOR_HALF_WIDTH * 2, 3.0 - 2.17, 0.3]}
      />

      {/* Wainscot + trim on the inside surface of every wall (exam room only) */}
      <WallTrim span={[WORLD_LEFT_X, WORLD_RIGHT_X]} axis="x" atCoord={WORLD_BACK_Z} flip={false} />
      <WallTrim span={[ROOM_BACK_Z, ROOM_FRONT_Z]} axis="z" atCoord={WORLD_LEFT_X} flip={false} />
      <WallTrim span={[ROOM_BACK_Z, ROOM_FRONT_Z]} axis="z" atCoord={WORLD_RIGHT_X} flip={true} />
      {FRONT_WALL_SEGMENTS.map((seg, i) => (
        <WallTrim
          key={`fw-trim-${i}`}
          span={[seg.center - seg.length / 2, seg.center + seg.length / 2]}
          axis="x"
          atCoord={ROOM_FRONT_Z}
          flip={true}
        />
      ))}

      {/* Ceiling panel — flush with the interior wall faces, no seam gap */}
      <mesh position={[OUTER_CENTER_X, 3.0, (ROOM_BACK_Z + ROOM_FRONT_Z) / 2]} rotation={[Math.PI / 2, 0, 0]}>
        <planeGeometry args={[OUTER_WIDTH - 0.3, ROOM_FRONT_Z - ROOM_BACK_Z - 0.3]} />
        <meshStandardMaterial color={PALETTE.ceiling} roughness={0.95} side={THREE.DoubleSide} />
      </mesh>

      <DoorFrame />
      <DoorLeaf open={doorOpen} side="left" />
      <DoorLeaf open={doorOpen} side="right" />

      {/* Ceiling lights */}
      <CeilingLight position={[-3, 2.9, ROOM_BACK_Z + 2]} />
      <CeilingLight position={[3, 2.9, ROOM_BACK_Z + 2]} />
      <CeilingLight position={[0, 2.9, ROOM_BACK_Z + 5]} />
      <CeilingLight position={[0, 2.9, (ROOM_FRONT_Z + CORRIDOR_FRONT_Z) / 2]} />

      {/* Corridor guidance stripes → door */}
      <FloorStripe x={0} zStart={6} zEnd={ROOM_FRONT_Z + 0.5} color={PALETTE.accent} />

      {/* Back wall signage */}
      <SpecialtyPoster
        position={[-3.0, 2.2, ROOM_BACK_Z + 0.18]}
        title={clinicLabel.toUpperCase()}
        subtitle="DR. CONSULTATION ROOM"
      />
      <WallDiplomas />

      {/* Side-wall decor (muayenehane atmosphere) */}
      <AnatomyPoster
        position={[WORLD_LEFT_X + 0.18, 1.6, ROOM_BACK_Z + 5.0]}
        rotationY={Math.PI / 2}
      />
      <Bookshelf
        position={[WORLD_LEFT_X + 0.4, 0, ROOM_BACK_Z + 1.2]}
        rotationY={Math.PI / 2}
      />

      {/* Window on the left wall — sits in the wall opening; the outdoor
          backdrop beyond the wall shows through it */}
      <Window position={[WORLD_LEFT_X + 0.17, 1.6, WINDOW_CENTER_Z]} />

      {/* Framed personal photos next to the diplomas */}
      <FramedPhoto position={[-1.6, 2.0, ROOM_BACK_Z + 0.17]} tone="mountain" />
      <FramedPhoto position={[-1.6, 1.35, ROOM_BACK_Z + 0.17]} tone="sea" />
      <FramedPhoto position={[3.8, 1.25, ROOM_BACK_Z + 0.17]} tone="sunset" />

      {/* Tall corner plant in the back-right corner — replaces the old
          duplicate potted-plant that was sitting in the same spot. */}
      <CornerPlant position={[WORLD_RIGHT_X - 0.55, 0, ROOM_BACK_Z + 0.75]} />

      {/* Floor book stack next to the bookshelf */}
      <FloorBooks position={[WORLD_LEFT_X + 0.65, 0, ROOM_BACK_Z + 2.5]} />

      {/* Corridor signage */}
      <CorridorSign position={[-3.6, 2.3, ROOM_FRONT_Z + 0.16]} title={clinicLabel.toUpperCase()} />
      <CorridorSign position={[3.6, 2.3, ROOM_FRONT_Z + 0.16]} title="POLYCLINIC" />
      <group position={[0, 2.5, CORRIDOR_FRONT_Z - 0.2]} rotation={[0, Math.PI, 0]}>
        <mesh>
          <boxGeometry args={[3.6, 0.6, 0.06]} />
          <meshStandardMaterial color={PALETTE.accent} emissive={PALETTE.accent} emissiveIntensity={0.4} />
        </mesh>
        <Text position={[0, 0, 0.04]} fontSize={0.22} color="#fff8ec" anchorX="center" anchorY="middle" fontWeight={700}>
          POLYCLINIC — {clinicLabel.toUpperCase()}
        </Text>
      </group>

      {/* Rug anchoring the consult area */}
      <Rug position={[0, 0, ROOM_BACK_Z + 4.2]} size={[3.6, 4.8]} />

      {/* Doctor's desk — the doctor seat is left empty because the player
          IS the doctor (first-person POV). The previous seated NPC was
          redundant and made the chair look occupied. */}
      <DoctorDesk
        position={DESK_POS}
        patient={
          patient
            ? {
                id: patient.case.id,
                name: patient.case.name,
                age: patient.case.age,
                gender: patient.case.gender,
                chiefComplaint: patient.case.chiefComplaint,
              }
            : null
        }
      />
      <DoctorChair position={DOCTOR_CHAIR_POS} rotationY={0} />

      {/* Patient chair — faces the doctor (−z direction). The patient
          figure (GLB Avatar) is rendered by WalkingPatient below; it
          stays on screen from walk-in through seated through walk-out
          so the character's identity is consistent. */}
      <PatientChair position={PATIENT_CHAIR_POS} rotationY={Math.PI} />
      {/* Single context-aware interactable: examines the patient when one
           is seated, otherwise opens the archive. */}
      <SeatedDoctorInteractable patientName={patient?.case.name ?? null} />

      {/* Side table beside the patient chair — tissues, water, magazine */}
      <SideTable position={[PATIENT_CHAIR_POS[0] + 1.0, 0, PATIENT_CHAIR_POS[2]]} />

      {/* Medicine cabinet on the right wall */}
      <MedicineCabinet
        position={[WORLD_RIGHT_X - 0.2, 1.55, ROOM_BACK_Z + 3.5]}
        rotationY={-Math.PI / 2}
      />

      {/* Filing cabinet against the back wall, left of the diplomas */}
      <FilingCabinet position={[-3.9, 0, ROOM_BACK_Z + 0.45]} />

      {/* Wall clock above the door, facing into the room */}
      <WallClock position={[0, 2.55, ROOM_FRONT_Z + 0.18]} rotationY={Math.PI} />

      {/* Coat rack in the front-right corner OF THE EXAM ROOM with three
          hung coats — spare white doctor's coat, a wool overcoat, and a
          blue jacket. Sits just inside the room so it's visible from the
          patient chair as well as from the corridor through the open door. */}
      <CoatRack position={[WORLD_RIGHT_X - 0.75, 0, ROOM_FRONT_Z - 0.6]} />

      {/* Anatomical teaching skeleton on a wheeled stand — front-left
          corner. The old bare wall behind the patient chair gets a real
          clinical focal point. */}
      <Skeleton
        position={[WORLD_LEFT_X + 0.7, 0, ROOM_FRONT_Z - 0.6]}
        rotationY={2.45}
        scale={1.18}
      />

      {/* Examination couch — flush against the right wall, long axis
          parallel to the wall (along world z). Head toward the back wall. */}
      <ExamBed position={[WORLD_RIGHT_X - 0.55, 0, ROOM_BACK_Z + 5.0]} rotationY={0} />

      {/* Ceiling exam light over the patient chair */}
      <ExamLight position={[PATIENT_CHAIR_POS[0] + 0.6, 2.95, PATIENT_CHAIR_POS[2] - 0.4]} />
      {/* Second pendant over the examination couch (now wall-side) */}
      <ExamLight position={[WORLD_RIGHT_X - 0.55, 2.95, ROOM_BACK_Z + 5.0]} />

      {/* Front-wall decor (the wall BEHIND the patient's back) — was
          previously a blank painted surface, now dressed like a real
          consulting room with a first-aid cabinet, bulletin board and a
          framed photo to flank the door. */}
      <FirstAidCabinet
        position={[-3.2, 1.55, ROOM_FRONT_Z - 0.16]}
        rotationY={Math.PI}
      />
      <BulletinBoard
        position={[3.2, 1.6, ROOM_FRONT_Z - 0.16]}
        rotationY={Math.PI}
      />
      <FramedPhoto
        position={[-3.2, 0.7, ROOM_FRONT_Z - 0.16]}
        rotationY={Math.PI}
        tone="mountain"
      />

      {/* Water cooler in the front-left corner */}
      <WaterCooler position={[WORLD_LEFT_X + 0.35, 0, ROOM_FRONT_Z + 0.45]} />

      {/* Patient walk-in / walk-out animation (hidden when seated) */}
      <WalkingPatient
        hasPatient={!!patient}
        patientKey={patientKey}
        age={patient?.case.age}
        gender={patient?.case.gender}
        caseId={patient?.case.id}
        severity={patient?.case.severity}
        complaint={patient?.case.chiefComplaint}
      />

      {/* Floating voice panel — anchored well ABOVE the seated patient's
          head so the bubble doesn't cover their face. The speech-tail on
          the bubble still points down toward the patient, giving the
          classic comic-book look without clipping the head. */}
      {voiceActive && patient && (
        <FloatingVoicePanel
          bedPosition={PATIENT_CHAIR_POS}
          bedRotationY={Math.PI}
          headOffset={[0, 1.85, 0]}
          patient={patient}
          onClose={() => onCloseVoice?.()}
        />
      )}

      {/* Floor label inside the exam room */}
      <Text
        position={[-2.5, 0.05, ROOM_BACK_Z + 6.2]}
        rotation={[-Math.PI / 2, 0, 0]}
        fontSize={0.2}
        color="#8b7a63"
        anchorX="center"
        anchorY="middle"
      >
        CONSULTATION
      </Text>
    </>
  );
}
