/**
 * Task list UI. The demo task asks you to:
 * 1. Add a priority select to the create form.
 * 2. Add a priority badge to each task row.
 * (See the TODO(demo) markers.)
 */
import React, { useEffect, useState } from "react";
import { createTask, listTasks, type Task } from "./api";

export const App: React.FC = () => {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  // TODO(demo): track the selected priority in form state.

  useEffect(() => {
    listTasks().then(setTasks);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    const task = await createTask({ title: title.trim(), description: description.trim() || undefined });
    setTasks((prev) => [...prev, task]);
    setTitle("");
    setDescription("");
  };

  return (
    <main style={{ fontFamily: "system-ui", padding: 24 }}>
      <h1>Tasks</h1>
      <ul>
        {tasks.map((t) => (
          <li key={t.id} style={{ marginBottom: 8 }}>
            <strong style={{ textDecoration: t.completed ? "line-through" : "none" }}>
              {t.title}
            </strong>
            {/* TODO(demo): render a priority badge next to the title. */}
            {t.description && <p style={{ margin: "4px 0", color: "#666" }}>{t.description}</p>}
          </li>
        ))}
      </ul>

      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 320 }}>
        <input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <input
          placeholder="Description (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        {/* TODO(demo): add a Priority <select> (low | medium | high, default medium). */}
        <button type="submit">Add task</button>
      </form>
    </main>
  );
};
