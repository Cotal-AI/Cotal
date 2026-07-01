// face-plugin.mjs — example-local OpenCode plugin: a clean way for a mesh face to drive its
// expression. Each `face_<mood>` is a no-op tool the agent calls when its mood shifts; face-term
// reads the tool call off the session event stream and animates the avatar.
//
// Why a tool and not an inline [[face:X]] tag: the personas answer ONLY through tools ("plain text
// vanishes"), and the de-leak removed the connector's wire-side tag stripping. A tool call is
// therefore the one mechanism that (a) obeys that rule with no contradiction and (b) keeps the
// agent's cotal_send / cotal_dm text clean on the wire AND in the on-screen console — the
// expression never appears as message text anywhere on the mesh.
//
// This is the example's own protocol; shared connector code knows nothing about faces. The tools
// are plain ToolDefinition objects — OpenCode's `tool()` helper is an identity wrapper, so no
// import is needed (and no zod: the mood rides the tool NAME, so each tool takes no arguments).

const FACE = (mood) => ({
  description:
    `Set your animated face to "${mood}". Call this the moment your mood becomes ${mood}. It only ` +
    `drives your avatar — it is NOT a message and no peer ever sees it, so your cotal_send / ` +
    `cotal_dm / cotal_anycast text stays clean.`,
  args: {},
  async execute() {
    return `face → ${mood}`;
  },
});

export const facePlugin = async () => ({
  tool: {
    face_neutral: FACE("neutral"),
    face_happy: FACE("happy"),
    face_sad: FACE("sad"),
    face_angry: FACE("angry"),
    face_surprised: FACE("surprised"),
  },
});
