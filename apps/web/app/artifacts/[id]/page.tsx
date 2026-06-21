"use client";

import { useMemo } from "react";
import { useParams } from "next/navigation";

import { ArtifactDetail } from "../../../components/artifact-detail";
import { browserApi } from "../../../lib/api";

export default function ArtifactDetailPage() {
  const api = useMemo(browserApi, []);
  const params = useParams<{ id: string }>();
  return <ArtifactDetail api={api} artifactId={params.id} />;
}
