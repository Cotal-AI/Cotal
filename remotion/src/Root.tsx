import { Composition } from "remotion";
import { ModeMulticast } from "./modes/Multicast";
import { ModeUnicast } from "./modes/Unicast";
import { ModeAnycast } from "./modes/Anycast";
import { STAGE } from "./modes/scene";
import { PeerMesh } from "./variants/PeerMesh";
import { Observer } from "./variants/Observer";
import { WireTrace } from "./variants/WireTrace";
import { Triptych } from "./variants/Triptych";
import { MeshFrame } from "./variants/MeshFrame";
import { MeshFull } from "./variants/MeshFull";
import { MeshBanner } from "./variants/MeshBanner";
import { MeshRing } from "./variants/MeshRing";
import { HeaderMorph } from "./header/HeaderMorph";
import { HeaderModesReel } from "./header/HeaderModesReel";
import { HeaderAssemble } from "./header/HeaderAssemble";
import { HeaderBanner } from "./header/HeaderBanner";
import { S1Problem } from "./explainer/S1Problem";
import { S2Shift } from "./explainer/S2Shift";
import { S3Modes } from "./explainer/S3Modes";
import { S4CrossVendor } from "./explainer/S4CrossVendor";
import { S5Topology } from "./explainer/S5Topology";
import { S6Logo } from "./explainer/S6Logo";
import { ExplainerCore } from "./explainer/ExplainerCore";
import { ExplainerFull } from "./explainer/ExplainerFull";
import { HeaderCut } from "./explainer/HeaderCut";
import { S0Headline } from "./explainer/S0Headline";
import { S7Command } from "./explainer/S7Command";
import { DemoLoop } from "./explainer/DemoLoop";
import { DemoCommand } from "./explainer/DemoCommand";
import { DemoHeadline } from "./explainer/DemoHeadline";
import { DemoShort } from "./explainer/DemoShort";
import { S5TopologyVendors, S5TopologyVendorsCodex } from "./explainer/S5TopologyVendors";
import { DemoMerged } from "./explainer/DemoMerged";
import { DemoMergedCodex } from "./explainer/DemoMergedCodex";
import { S5TopologyRotate } from "./explainer/S5TopologyRotate";
import { S5TopologyShuffle } from "./explainer/S5TopologyShuffle";
import { DemoCodexRotate } from "./explainer/DemoCodexRotate";
import { DemoCodexShuffle } from "./explainer/DemoCodexShuffle";
import { DemoReadme } from "./explainer/DemoReadme";
import { ExplainerMerged } from "./explainer/ExplainerMerged";

const EXPL = { fps: 30, width: 1920, height: 1080 } as const;

const COMMON = { durationInFrames: 120, fps: 30, width: 1280 } as const;

const MODE = { fps: 30, width: STAGE.w, height: STAGE.h } as const;

export const Root: React.FC = () => {
  return (
    <>
      <Composition id="ModeMulticast" component={ModeMulticast} durationInFrames={150} {...MODE} />
      <Composition id="ModeUnicast" component={ModeUnicast} durationInFrames={168} {...MODE} />
      <Composition id="ModeAnycast" component={ModeAnycast} durationInFrames={162} {...MODE} />
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
      <Composition id="HeaderModesReel" component={HeaderModesReel} fps={30} width={1080} height={1080} durationInFrames={555} />
      <Composition id="HeaderAssemble" component={HeaderAssemble} fps={30} width={1080} height={1080} durationInFrames={210} />
      <Composition id="HeaderBanner" component={HeaderBanner} fps={30} width={1280} height={340} durationInFrames={180} />

      {/* Clear-message explainer: modular snippets + masters (1920x1080). */}
      <Composition id="S1Problem" component={S1Problem} durationInFrames={150} {...EXPL} />
      <Composition id="S2Shift" component={S2Shift} durationInFrames={150} {...EXPL} />
      <Composition id="S3Modes" component={S3Modes} durationInFrames={210} {...EXPL} />
      <Composition id="S4CrossVendor" component={S4CrossVendor} durationInFrames={150} {...EXPL} />
      <Composition id="S5Topology" component={S5Topology} durationInFrames={150} {...EXPL} />
      <Composition id="S6Logo" component={S6Logo} durationInFrames={120} {...EXPL} />
      <Composition id="ExplainerCore" component={ExplainerCore} durationInFrames={780} {...EXPL} />
      <Composition id="ExplainerFull" component={ExplainerFull} durationInFrames={930} {...EXPL} />
      <Composition id="HeaderCut" component={HeaderCut} durationInFrames={270} {...EXPL} />

      {/* Cross-vendor demo cuts (remixable loops) + their two new snippets. */}
      <Composition id="S0Headline" component={S0Headline} durationInFrames={110} {...EXPL} />
      <Composition id="S7Command" component={S7Command} durationInFrames={135} {...EXPL} />
      <Composition id="DemoLoop" component={DemoLoop} durationInFrames={420} {...EXPL} />
      <Composition id="DemoCommand" component={DemoCommand} durationInFrames={555} {...EXPL} />
      <Composition id="DemoHeadline" component={DemoHeadline} durationInFrames={665} {...EXPL} />
      <Composition id="DemoShort" component={DemoShort} durationInFrames={380} {...EXPL} />

      {/* Vendor symbols AS the topology agents (cross-vendor + any-topology in one beat). */}
      <Composition id="S5TopologyVendors" component={S5TopologyVendors} durationInFrames={240} {...EXPL} />
      <Composition id="S5TopologyVendorsCodex" component={S5TopologyVendorsCodex} durationInFrames={240} {...EXPL} />
      <Composition id="DemoMerged" component={DemoMerged} durationInFrames={605} {...EXPL} />
      <Composition id="DemoMergedCodex" component={DemoMergedCodex} durationInFrames={605} {...EXPL} />
      <Composition id="S5TopologyRotate" component={S5TopologyRotate} durationInFrames={240} {...EXPL} />
      <Composition id="S5TopologyShuffle" component={S5TopologyShuffle} durationInFrames={240} {...EXPL} />
      <Composition id="DemoCodexRotate" component={DemoCodexRotate} durationInFrames={605} {...EXPL} />
      <Composition id="DemoCodexShuffle" component={DemoCodexShuffle} durationInFrames={605} {...EXPL} />
      <Composition id="DemoReadme" component={DemoReadme} durationInFrames={350} {...EXPL} />
      <Composition id="ExplainerMerged" component={ExplainerMerged} durationInFrames={1155} {...EXPL} />
    </>
  );
};
