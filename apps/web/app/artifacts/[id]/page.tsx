"use client";

import { useParams } from "next/navigation";

import { ArtifactDetail } from "../../../components/artifact-detail";
import { browserApi } from "../../../lib/api";

export default function ArtifactDetailPage() {
  const params = useParams<{ id: string }>();
  return <ArtifactDetail api={browserApi()} artifactId={params.id} />;
}
