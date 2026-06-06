/**
 * Task list UI with task priority: a select in the create form and a badge per row.
 * Talks to the real todo-api /tasks endpoint via ./api.
 */
import React, { useEffect, useState } from "react";
import { createTask, listTasks, type Priority, type Task } from "./api";

const PRIORITY_COLORS: Record<Priority, string> = {
  low: "#3b8c3b",
  medium: "#b8860b",
  high: "#c0392b",
};

const PriorityBadge: React.FC<{ priority: Priority }> = ({ priority }) => (
  <span
    style={{
      marginLeft: 8,
      padding: "1px 8px",
      borderRadius: 10,
      fontSize: 12,
      color: "#fff",
      background: PRIORITY_COLORS[priority],
    }}
  >
    {priority}
  </span>
);

export const App: React.FC = () => {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Priority>("medium");

  useEffect(() => {
    listTasks().then(setTasks);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    const task = await createTask({ title: title.trim(), description: description.trim() || undefined, priority });
    setTasks((prev) => [...prev, task]);
    setTitle("");
    setDescription("");
    setPriority("medium");
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
            <PriorityBadge priority={t.priority} />
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
        <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
        <button type="submit">Add task</button>
      </form>
    </main>
  );
};
