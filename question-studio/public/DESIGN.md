# Question Studio interface

Mode: Operate. Direction: the user's pinned Codex-style desktop workspace.

Three persistent regions organize the work: topic selection and budget on the left, generation activity and controls in the center, translated question inspection on the right. Below 940px topics open as a dismissible drawer; below 680px review follows generation in document flow.

The system uses Segoe UI/system sans, 14px base text, 11–12px compact controls and metadata, a 25px task heading, and tabular numeric figures. Surfaces are charcoal: canvas `#191a1c`, sidebar `#131416`, review `#1c1d1f`, raised controls `#222426`, separators `#333538`. Primary text is `#eeefed`, secondary text `#aaadaf`. The pale green action accent `#d2e7c4` carries selection and primary controls. Success, warning and error use consistent semantic colors.

Content stays in flat regions with thin separators. No ornamental imagery, gradients, floating statistic cards or decorative animations. The sole recurring animation is the small running status indicator; reduced motion disables it. Controls use 8px radii and a visible 2px keyboard focus outline. All API text enters the DOM through textContent; local KaTeX renders math with trust disabled.

Visible states include disconnected/retry, idle, running, paused, completed, errors, budget exhaustion, empty topics, empty question categories, failed validation, published questions, pending actions and missing translations.
