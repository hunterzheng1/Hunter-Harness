"use client";

import { useParams } from "next/navigation";

import { ProjectWorkspace } from "../../../components/project-workspace";
import { browserApi } from "../../../lib/api";

export default function ProjectDetailPage() {
  const params = useParams<{ id: string }>();
  return <ProjectWorkspace api={browserApi()} projectId={params.id} />;
}
