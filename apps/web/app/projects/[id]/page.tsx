"use client";

import { useParams } from "next/navigation";
import { useMemo } from "react";

import { ProjectWorkspace } from "../../../components/project-workspace";
import { browserApi, type HunterApi } from "../../../lib/api";
import { mockApi } from "../../../lib/mock-api";

function resolveApi(): HunterApi {
  return process.env.NEXT_PUBLIC_HUNTER_HARNESS_DEMO === "true" ? mockApi : browserApi();
}

export default function ProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const api = useMemo(() => resolveApi(), []);
  return <ProjectWorkspace api={api} projectId={params.id} />;
}
