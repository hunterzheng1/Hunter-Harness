"use client";

import { useMemo } from "react";

import { ProjectRegistry } from "../../components/console";
import { browserApi } from "../../lib/api";

export default function ProjectsPage() {
  const api = useMemo(browserApi, []);
  return <ProjectRegistry api={api} />;
}
