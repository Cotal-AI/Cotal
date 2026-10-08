import { Composition } from "remotion";
import { ModeMulticast, MULTICAST_DURATION } from "./modes/Multicast";
import { ModeUnicast, UNICAST_DURATION } from "./modes/Unicast";
import { ModeAnycast, ANYCAST_DURATION } from "./modes/Anycast";
import { NatsIdentity } from "./nats/Identity";
import { NatsReplay } from "./nats/Replay";
import { NatsAttention } from "./nats/Attention";
import { MODE_STAGE, NATS_STAGE } from "./modes/scene";
import { PeerMesh } from "./variants/PeerMesh";
import { Observer } from "./variants/Observer";
import { WireTrace } from "./variants/WireTrace";
import { Triptych } from "./variants/Triptych";
import { MeshFrame } from "./variants/MeshFrame";
import { MeshFull } from "./variants/MeshFull";
import { MeshBanner } from "./variants/MeshBanner";
import { MeshRing } from "./variants/MeshRing";
import { HeaderMorph } from "./header/HeaderMorph";
import { HeaderModesReel, REEL_DURATION } from "./header/HeaderModesReel";
import { HeaderAssemble } from "./header/HeaderAssemble";
import { HeaderBanner } from "./header/HeaderBanner";
import { S1Problem, PROBLEM_DURATION } from "./explainer/S1Problem";
import { S2Shift, SHIFT_DURATION } from "./explainer/S2Shift";
import { S3Modes, MODES_DURATION } from "./explainer/S3Modes";
import { S4CrossVendor, CROSS_VENDOR_DURATION } from "./explainer/S4CrossVendor";
import { S5Topology, TOPOLOGY_DURATION } from "./explainer/S5Topology";
import { S6Logo, LOGO_DURATION } from "./explainer/S6Logo";
import { ExplainerCore, EXPLAINER_CORE_DURATION } from "./explainer/ExplainerCore";
import { ExplainerFull, EXPLAINER_FULL_DURATION } from "./explainer/ExplainerFull";
import { HeaderCut, HEADER_CUT_DURATION } from "./explainer/HeaderCut";
import { S0Headline, HEADLINE_DURATION } from "./explainer/S0Headline";
import { S7Command, COMMAND_DURATION } from "./explainer/S7Command";
import { DemoLoop, DEMO_LOOP_DURATION } from "./explainer/DemoLoop";
import { DemoCommand, DEMO_COMMAND_DURATION } from "./explainer/DemoCommand";
import { DemoHeadline, DEMO_HEADLINE_DURATION } from "./explainer/DemoHeadline";
import { DemoShort, DEMO_SHORT_DURATION } from "./explainer/DemoShort";
import { S5TopologyVendors, S5TopologyVendorsCodex, TOPOLOGY_VENDORS_DURATION } from "./explainer/S5TopologyVendors";
import { DemoMerged, DEMO_MERGED_DURATION } from "./explainer/DemoMerged";
import { DemoMergedCodex, DEMO_MERGED_CODEX_DURATION } from "./explainer/DemoMergedCodex";
import { S5TopologyRotate, TOPOLOGY_ROTATE_DURATION } from "./explainer/S5TopologyRotate";
import { S5TopologyShuffle, TOPOLOGY_SHUFFLE_DURATION } from "./explainer/S5TopologyShuffle";
import { DemoCodexRotate, DEMO_CODEX_ROTATE_DURATION } from "./explainer/DemoCodexRotate";
import { DemoCodexShuffle, DEMO_CODEX_SHUFFLE_DURATION } from "./explainer/DemoCodexShuffle";
import { DemoReadme, DEMO_README_DURATION } from "./explainer/DemoReadme";
import { ExplainerMerged, EXPLAINER_MERGED_DURATION } from "./explainer/ExplainerMerged";

const EXPL = { fps: 30, width: 1920, height: 1080 } as const;

const COMMON = { durationInFrames: 120, fps: 30, width: 1280 } as const;

const MODE = { fps: 30, width: MODE_STAGE.w, height: MODE_STAGE.h } as const;
const NATS = { fps: 30, width: NATS_STAGE.w, height: NATS_STAGE.h } as const;

export const Root: React.FC = () => {
  return (
    <>
      <Composition id="ModeMulticast" component={ModeMulticast} durationInFrames={MULTICAST_DURATION} {...MODE} />
      <Composition id="ModeUnicast" component={ModeUnicast} durationInFrames={UNICAST_DURATION} {...MODE} />
      <Composition id="ModeAnycast" component={ModeAnycast} durationInFrames={ANYCAST_DURATION} {...MODE} />
      <Composition id="NatsIdentity" component={NatsIdentity} durationInFrames={210} {...NATS} />
      <Composition id="NatsReplay" component={NatsReplay} durationInFrames={180} {...NATS} />
      <Composition id="NatsAttention" component={NatsAttention} durationInFrames={180} {...NATS} />
      <Composition id="PeerMesh" component={PeerMesh} height={340} {...COMMON} />
      <Composition id="Observer" component={Observer} height={360} {...COMMON} />
      <Composition id="WireTrace" component={WireTrace} height={320} {...COMMON} />
      <Composition id="Triptych" component={Triptych} height={320} {...COMMON} />
      <Composition id="MeshFrame" component={MeshFrame} height={360} {...COMMON} />
      <Composition id="MeshFull" component={MeshFull} height={360} {...COMMON} />
      <Composition id="MeshBanner" component={MeshBanner} height={200} {...COMMON} />
      <Composition id="MeshRing" component={MeshRing} height={340} {...COMMON} />

      {/* Header-video candidates (cream/gold), to compare and pick one. */}
      <Composition id="HeaderMorph" component={HeaderMorph} fps={30} width={1280} height={400} durationInFrames={240} />
      <Composition id="HeaderModesReel" component={HeaderModesReel} fps={30} width={1080} height={1080} durationInFrames={REEL_DURATION} />
      <Composition id="HeaderAssemble" component={HeaderAssemble} fps={30} width={1080} height={1080} durationInFrames={210} />
      <Composition id="HeaderBanner" component={HeaderBanner} fps={30} width={1280} height={340} durationInFrames={180} />

      {/* Clear-message explainer: modular snippets + masters (1920x1080). */}
      <Composition id="S1Problem" component={S1Problem} durationInFrames={PROBLEM_DURATION} {...EXPL} />
      <Composition id="S2Shift" component={S2Shift} durationInFrames={SHIFT_DURATION} {...EXPL} />
      <Composition id="S3Modes" component={S3Modes} durationInFrames={MODES_DURATION} {...EXPL} />
      <Composition id="S4CrossVendor" component={S4CrossVendor} durationInFrames={CROSS_VENDOR_DURATION} {...EXPL} />
      <Composition id="S5Topology" component={S5Topology} durationInFrames={TOPOLOGY_DURATION} {...EXPL} />
      <Composition id="S6Logo" component={S6Logo} durationInFrames={LOGO_DURATION} {...EXPL} />
      <Composition id="ExplainerCore" component={ExplainerCore} durationInFrames={EXPLAINER_CORE_DURATION} {...EXPL} />
      <Composition id="ExplainerFull" component={ExplainerFull} durationInFrames={EXPLAINER_FULL_DURATION} {...EXPL} />
      <Composition id="HeaderCut" component={HeaderCut} durationInFrames={HEADER_CUT_DURATION} {...EXPL} />

      {/* Cross-vendor demo cuts (remixable loops) + their two new snippets. */}
      <Composition id="S0Headline" component={S0Headline} durationInFrames={HEADLINE_DURATION} {...EXPL} />
      <Composition id="S7Command" component={S7Command} durationInFrames={COMMAND_DURATION} {...EXPL} />
      <Composition id="DemoLoop" component={DemoLoop} durationInFrames={DEMO_LOOP_DURATION} {...EXPL} />
      <Composition id="DemoCommand" component={DemoCommand} durationInFrames={DEMO_COMMAND_DURATION} {...EXPL} />
      <Composition id="DemoHeadline" component={DemoHeadline} durationInFrames={DEMO_HEADLINE_DURATION} {...EXPL} />
      <Composition id="DemoShort" component={DemoShort} durationInFrames={DEMO_SHORT_DURATION} {...EXPL} />

      {/* Vendor symbols AS the topology agents (cross-vendor + any-topology in one beat). */}
      <Composition id="S5TopologyVendors" component={S5TopologyVendors} durationInFrames={TOPOLOGY_VENDORS_DURATION} {...EXPL} />
      <Composition id="S5TopologyVendorsCodex" component={S5TopologyVendorsCodex} durationInFrames={TOPOLOGY_VENDORS_DURATION} {...EXPL} />
      <Composition id="DemoMerged" component={DemoMerged} durationInFrames={DEMO_MERGED_DURATION} {...EXPL} />
      <Composition id="DemoMergedCodex" component={DemoMergedCodex} durationInFrames={DEMO_MERGED_CODEX_DURATION} {...EXPL} />
      <Composition id="S5TopologyRotate" component={S5TopologyRotate} durationInFrames={TOPOLOGY_ROTATE_DURATION} {...EXPL} />
      <Composition id="S5TopologyShuffle" component={S5TopologyShuffle} durationInFrames={TOPOLOGY_SHUFFLE_DURATION} {...EXPL} />
      <Composition id="DemoCodexRotate" component={DemoCodexRotate} durationInFrames={DEMO_CODEX_ROTATE_DURATION} {...EXPL} />
      <Composition id="DemoCodexShuffle" component={DemoCodexShuffle} durationInFrames={DEMO_CODEX_SHUFFLE_DURATION} {...EXPL} />
      <Composition id="DemoReadme" component={DemoReadme} durationInFrames={DEMO_README_DURATION} {...EXPL} />
      <Composition id="ExplainerMerged" component={ExplainerMerged} durationInFrames={EXPLAINER_MERGED_DURATION} {...EXPL} />
    </>
  );
};
