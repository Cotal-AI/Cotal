// Takes the compile cache API away from a Node new enough to report the floor, which is the one
// case a version check alone would wave through into a `TypeError`.
delete require("node:module").flushCompileCache;
