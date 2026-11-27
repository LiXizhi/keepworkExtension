import type { Device } from "./bumi-workspace";
import type { EmbodiedDirection } from "./bumi-embodied";
import type { ClassroomPulseProfile } from "./bumi-classroom-vision";

export interface TeachAction {
  id: number;
  name: string;
  duration?: number | null;
  time?: string | null;
}
export type LocomotionMode = "walk" | "run";
export type Gesture = "dance" | "wave" | "handshake" | "cheer";
export type PostureAction = LocomotionMode | Gesture | "standUp" | "standToFall";
export interface Snapshot {
  available: boolean;
  devices: Device[];
  connected: Device | null;
  connectionId?: string | null;
  battery: number | null;
  status: number | null;
  moving: boolean;
  walkMode: boolean;
  locomotionMode?: LocomotionMode | null;
  remoteMotionVersion?: number;
  remoteMenuSwitch?: boolean;
  remoteVoiceCommandVersion?: number;
  remoteVoiceGestures?: boolean;
  remoteVoiceContinue?: boolean;
  remoteVoiceStepDirections?: boolean;
  guidedMotionVersion?: number;
  sceneWalkPathVersion?: number;
  automaticWalkClearanceVersion?: number;
  walkFloorScaleVersion?: number;
  walkIntentVersion?: number;
  sceneVisionVersion?: number;
  sceneConfidenceVersion?: number;
  sceneInspectionVersion?: number;
  searchViewVersion?: number;
  walkContinueVersion?: number;
  singleFrameDirectionsVersion?: number;
  singleFrameRouteVersion?: number;
  singleFrameEstimatedStepVersion?: number;
  singleFramePulseDirectionsVersion?: number;
  classroomPulseVersion?: number;
  sceneSpokenChoice?: boolean;
  teachVersion?: number;
  teachRecording?: boolean;
  teachActions?: TeachAction[];
  listening: boolean;
}
export interface BluetoothMessage {
  direction?: "tx" | "rx";
  receivedAt: string;
  size: number;
  truncated: boolean;
  hex: string;
  opcode: number | null;
  summary: string;
  text: string | null;
}
type Command =
  | { action: "battery" | "status" | PostureAction | "startTeach" | "stopTeach" | "teachList" }
  | { action: "saveTeach"; name: string }
  | { action: "playTeach" | "deleteTeach"; id: number }
  | { action: "volume"; percent: number }
  | ({ action: "move" } & Motion)
  | { action: "speak"; text: string };
export type Request =
  | { operation: "status" | "disconnect" }
  | { operation: "listen"; enabled: boolean }
  | { operation: "beginClassroom"; taskId: string; connectionId: string; captureId?: number; voiceId?: number; pulseProfile?: ClassroomPulseProfile }
  | { operation: "classroomStep"; taskId: string; sequence: number; action: EmbodiedDirection | "handshake" | "wave" | "greet" | "askDoorOrLectern" | "askWhich" }
  | { operation: "endClassroom"; taskId: string }
  | { operation: "classroomStop"; taskId: string; sequence: number }
  | { operation: "send"; command: Command; remoteCaptureId?: number; voiceId?: number };
export interface Motion { vx: number; vyaw: number; vy?: number }
