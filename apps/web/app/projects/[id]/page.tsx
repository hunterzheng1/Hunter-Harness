"use client";

import { useParams } from "next/navigation";

import { ProjectWorkspace } from "../../../components/project-workspace";
import { mockApi } from "../../../lib/mock-api";

export default function ProjectDetailPage() {
  const params = useParams<{ id: string }>();
  return <ProjectWorkspace api={mockApi} projectId={params.id} />;
}