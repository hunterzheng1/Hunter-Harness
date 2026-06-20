"use client";

import { useMemo } from "react";

import { ArtifactHistory } from "../../components/console";
import { browserApi } from "../../lib/api";

export default function ArtifactsPage() {
  const api = useMemo(browserApi, []);
  return <ArtifactHistory api={api} />;
}
