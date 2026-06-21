"use client";

import { useParams } from "next/navigation";

import { ArtifactDetail } from "../../../components/artifact-detail";
import { mockApi } from "../../../lib/mock-api";

export default function ArtifactDetailPage() {
  const params = useParams<{ id: string }>();
  return <ArtifactDetail api={mockApi} artifactId={params.id} />;
}