#!/usr/bin/env bash
# tmux-brand.sh — shared Cotal status-bar branding for the demo walls.
# Source this file, then call:  brand_tmux <session>
# Adds a persistent bottom bar: "● Cotal · the web for agents" (left) and "cotal.ai" (right),
# so the brand + URL stay on screen for a live-event monitor even as panes scroll.

brand_tmux() {
  local s="$1"
  tmux set-option -t "$s" status on                                   2>/dev/null || true
  tmux set-option -t "$s" status-position bottom                      2>/dev/null || true
  tmux set-option -t "$s" status-justify centre                       2>/dev/null || true
  tmux set-option -t "$s" status-style "bg=#0d1117,fg=#8b949e"        2>/dev/null || true
  tmux set-option -t "$s" status-left-length  60                      2>/dev/null || true
  tmux set-option -t "$s" status-right-length 40                      2>/dev/null || true
  tmux set-option -t "$s" status-left  "#[fg=#58a6ff,bold] ● Cotal #[fg=#8b949e,nobold]· the web for agents " 2>/dev/null || true
  tmux set-option -t "$s" status-right "#[fg=#58a6ff,bold]cotal.ai #[default]" 2>/dev/null || true
  tmux set-option -t "$s" window-status-format ""                     2>/dev/null || true
  tmux set-option -t "$s" window-status-current-format ""             2>/dev/null || true
}
