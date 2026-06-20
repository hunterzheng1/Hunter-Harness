"use client";

import { useMemo } from "react";
import { useParams } from "next/navigation";

import { ProjectWorkspace } from "../../../components/project-workspace";
import { browserApi } from "../../../lib/api";

export default function ProjectDetailPage() {
  const api = useMemo(browserApi, []);
  const params = useParams<{ id: string }>();
  return <ProjectWorkspace api={api} projectId={params.id} />;
}
