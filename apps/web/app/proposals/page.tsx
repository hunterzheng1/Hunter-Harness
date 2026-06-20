"use client";

import { useMemo } from "react";

import { ReviewQueue } from "../../components/console";
import { browserApi } from "../../lib/api";

export default function ProposalsPage() {
  const api = useMemo(browserApi, []);
  return <ReviewQueue api={api} />;
}
