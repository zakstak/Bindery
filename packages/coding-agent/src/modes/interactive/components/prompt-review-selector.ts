import { Container, type SelectItem, SelectList, Spacer, Text } from "@mariozechner/pi-tui";
import type { PromptSourceProposal } from "../../../core/prompt-source-state.js";
import { getSelectListTheme, theme } from "../theme/theme.js";
import { renderDiff } from "./diff.js";
import { DynamicBorder } from "./dynamic-border.js";

export interface PromptReviewPanelState {
	canonicalPath: string;
	canonicalVersion: number;
	effectivePromptPreview: string;
	pendingProposal?: PromptSourceProposal;
	approvedProposals: PromptSourceProposal[];
}

export interface PromptReviewPanelCallbacks {
	onAcceptProposal: (proposal: PromptSourceProposal) => void;
	onRejectProposal: (proposal: PromptSourceProposal) => void;
	onRollbackToApproved: (proposal: PromptSourceProposal) => void;
	onCancel: () => void;
}

function getActionItems(state: PromptReviewPanelState): {
	items: SelectItem[];
	rollbackTargets: Map<string, PromptSourceProposal>;
} {
	const items: SelectItem[] = [];
	const rollbackTargets = new Map<string, PromptSourceProposal>();

	if (state.pendingProposal) {
		items.push(
			{ value: "accept", label: "Accept proposal", description: "Approve pending prompt proposal" },
			{ value: "reject", label: "Reject proposal", description: "Reject pending prompt proposal" },
		);
	}

	if (state.approvedProposals.length === 0) {
		items.push({
			value: "rollback:none",
			label: "Rollback to approved version",
			description: "No approved proposal available to roll back",
		});
	} else {
		for (const proposal of state.approvedProposals) {
			const value = `rollback:${proposal.proposedVersion}`;
			rollbackTargets.set(value, proposal);
			items.push({
				value,
				label: `Rollback to approved v${proposal.proposedVersion}`,
				description: `Create rollback decision from approved version ${proposal.proposedVersion}`,
			});
		}
	}

	items.push({ value: "close", label: "Close", description: "Return to editor" });

	return { items, rollbackTargets };
}

function sectionBody(text: string | undefined, fallback: string): string {
	const normalized = (text ?? "").trim();
	return normalized.length > 0 ? normalized : fallback;
}

export class PromptReviewSelectorComponent extends Container {
	private readonly actions: SelectList;
	private readonly rollbackTargets: Map<string, PromptSourceProposal>;

	constructor(state: PromptReviewPanelState, callbacks: PromptReviewPanelCallbacks) {
		super();

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold("Prompt Review")), 0, 0));
		this.addChild(new Text(theme.fg("muted", "Review-only panel (no freeform prompt editor)."), 0, 0));
		this.addChild(new Spacer(1));

		const pending = state.pendingProposal;
		if (pending) {
			this.addChild(
				new Text(
					theme.fg(
						"muted",
						`Pending version ${pending.proposedVersion} (base ${pending.baseVersion}) from ${pending.model}`,
					),
					0,
				),
			);
		} else {
			this.addChild(new Text(theme.fg("warning", "No pending prompt proposal for this session."), 0, 0));
		}
		this.addChild(
			new Text(theme.fg("dim", `Canonical source: ${state.canonicalPath} (v${state.canonicalVersion})`), 0, 0),
		);
		this.addChild(new Spacer(1));

		this.addChild(new Text(theme.bold("Effective Prompt Preview"), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(sectionBody(state.effectivePromptPreview, "(effective prompt preview unavailable)"), 0, 0),
		);
		this.addChild(new Spacer(1));

		this.addChild(new Text(theme.bold("Proposed Diff"), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				pending?.diff
					? renderDiff(pending.diff, { filePath: state.canonicalPath })
					: theme.fg("dim", "(no pending diff)"),
				0,
			),
		);
		this.addChild(new Spacer(1));

		this.addChild(new Text(theme.bold("Rationale"), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(sectionBody(pending?.rationale, "(no pending rationale)"), 0, 0));
		this.addChild(new Spacer(1));

		this.addChild(new Text(theme.bold("Actions"), 0, 0));
		this.addChild(new Spacer(1));
		const actionConfig = getActionItems(state);
		this.rollbackTargets = actionConfig.rollbackTargets;
		this.actions = new SelectList(actionConfig.items, 6, getSelectListTheme());
		this.actions.onSelect = (item) => {
			if (item.value === "accept") {
				if (pending) callbacks.onAcceptProposal(pending);
				return;
			}
			if (item.value === "reject") {
				if (pending) callbacks.onRejectProposal(pending);
				return;
			}
			if (item.value === "rollback:none") {
				callbacks.onCancel();
				return;
			}
			if (typeof item.value === "string" && item.value.startsWith("rollback:")) {
				const proposal = this.rollbackTargets.get(item.value);
				if (proposal) {
					callbacks.onRollbackToApproved(proposal);
				}
				return;
			}
			callbacks.onCancel();
		};
		this.actions.onCancel = callbacks.onCancel;
		this.addChild(this.actions);

		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to select action · Esc to close"), 0, 0));
		this.addChild(new DynamicBorder());
	}

	handleInput(data: string): void {
		this.actions.handleInput(data);
	}

	getActionList(): SelectList {
		return this.actions;
	}
}
