/**
 * Security Settings page - Passkey management
 *
 * Only available when using passkey auth. When external auth (e.g., Cloudflare Access)
 * is configured, this page shows an informational message instead.
 */

import { Banner, Button, SkeletonLine, useKumoToastManager } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Plus } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { deletePasskey, fetchManifest, fetchPasskeys, renamePasskey } from "../../lib/api";
import { PasskeyRegistration } from "../auth/PasskeyRegistration.js";
import { PasskeyList } from "./PasskeyList.js";
import { SettingRow, SettingsFrame, SettingsSection } from "./SettingsLayout.js";

interface SecuritySettingsProps {
	/** Open the add-passkey form, e.g. after signing in at a new address. */
	addPasskey?: boolean;
}

export function SecuritySettings({ addPasskey = false }: SecuritySettingsProps) {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const toastManager = useKumoToastManager();
	const [isAdding, setIsAdding] = React.useState(addPasskey);

	const { data: manifest, isLoading: manifestLoading } = useQuery({
		queryKey: ["manifest"],
		queryFn: fetchManifest,
	});

	const isExternalAuth = manifest?.authMode && manifest.authMode !== "passkey";

	const {
		data: passkeys,
		isLoading,
		error,
	} = useQuery({
		queryKey: ["passkeys"],
		queryFn: fetchPasskeys,
		enabled: !isExternalAuth && !manifestLoading,
	});

	const renameMutation = useMutation({
		mutationFn: ({ id, name }: { id: string; name: string }) => renamePasskey(id, name),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["passkeys"] });
			toastManager.add({ title: t`Passkey renamed`, variant: "success", timeout: 3000 });
		},
		onError: (mutationError) => {
			toastManager.add({
				title: t`Failed to rename passkey`,
				description: mutationError instanceof Error ? mutationError.message : t`An error occurred`,
				variant: "error",
				timeout: 3000,
			});
		},
	});

	const deleteMutation = useMutation({
		mutationFn: (id: string) => deletePasskey(id),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["passkeys"] });
			toastManager.add({ title: t`Passkey removed`, variant: "success", timeout: 3000 });
		},
		onError: (mutationError) => {
			toastManager.add({
				title: t`Failed to remove passkey`,
				description: mutationError instanceof Error ? mutationError.message : t`An error occurred`,
				variant: "error",
				timeout: 3000,
			});
		},
	});

	const handleRename = async (id: string, name: string) => {
		await renameMutation.mutateAsync({ id, name });
	};

	const handleDelete = async (id: string) => {
		await deleteMutation.mutateAsync(id);
	};

	const handleAddSuccess = () => {
		void queryClient.invalidateQueries({ queryKey: ["passkeys"] });
		setIsAdding(false);
		toastManager.add({ title: t`Passkey added successfully`, variant: "success", timeout: 3000 });
	};

	const title = t`Security Settings`;
	const description = t`Manage your passkeys and authentication`;

	if (manifestLoading) {
		// The auth mode decides whether this page has sections at all.
		return (
			<SettingsFrame title={title} description={description} loading>
				{null}
			</SettingsFrame>
		);
	}

	if (isExternalAuth) {
		return (
			<SettingsFrame title={title} description={description}>
				<Banner
					variant="secondary"
					title={t`Security Settings`}
					description={t`Authentication is managed by an external provider (${manifest?.authMode}). Passkey settings are not available when using external authentication.`}
					role="status"
				/>
			</SettingsFrame>
		);
	}

	if (error) {
		return (
			<SettingsFrame title={title} description={description}>
				<Banner
					variant="error"
					title={t`Failed to load passkeys`}
					description={error instanceof Error ? error.message : t`An error occurred`}
					role="alert"
				/>
			</SettingsFrame>
		);
	}

	return (
		<SettingsFrame title={title} description={description} loading={isLoading}>
			<div className="grid gap-8">
				<SettingsSection
					title={t`Passkeys`}
					description={t`Passkeys are a secure, passwordless way to sign in to your account. You can register multiple passkeys for different devices.`}
					contentClassName={
						isLoading || (passkeys && passkeys.length > 0)
							? undefined
							: "border-2 border-dashed border-kumo-subtle/60"
					}
				>
					<SettingRow className="p-0">
						{isLoading ? (
							<PasskeyPlaceholder />
						) : passkeys && passkeys.length > 0 ? (
							<PasskeyList
								passkeys={passkeys}
								onRename={handleRename}
								onDelete={handleDelete}
								isDeleting={deleteMutation.isPending}
								isRenaming={renameMutation.isPending}
							/>
						) : (
							<div className="px-4 py-8 text-center text-sm text-kumo-subtle">
								{t`No passkeys registered yet.`}
							</div>
						)}
					</SettingRow>
				</SettingsSection>

				<SettingsSection title={t`Add a new passkey`}>
					<SettingRow>
						{isAdding ? (
							<div className="grid gap-4">
								{addPasskey && (
									<Banner
										title={t`Add a passkey for ${window.location.host}`}
										description={t`Passkeys only work at the address where they were created. Add one here so you can sign in at this address next time.`}
									/>
								)}
								<div className="flex justify-end">
									<Button variant="ghost" size="sm" onClick={() => setIsAdding(false)}>
										{t`Cancel`}
									</Button>
								</div>
								<PasskeyRegistration
									optionsEndpoint="/_emdash/api/auth/passkey/register/options"
									verifyEndpoint="/_emdash/api/auth/passkey/register/verify"
									onSuccess={handleAddSuccess}
									onError={(registrationError) =>
										toastManager.add({
											title: t`Failed to add passkey`,
											description: registrationError.message,
											variant: "error",
											timeout: 3000,
										})
									}
									showNameInput
									buttonText={t`Register Passkey`}
								/>
							</div>
						) : (
							<Button onClick={() => setIsAdding(true)} icon={<Plus />} disabled={isLoading}>
								{t`Add Passkey`}
							</Button>
						)}
					</SettingRow>
				</SettingsSection>
			</div>
		</SettingsFrame>
	);
}

/** A passkey row in outline: most accounts have one passkey. */
function PasskeyPlaceholder() {
	return (
		<div
			aria-hidden="true"
			className="flex flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
		>
			<div className="flex min-w-0 flex-1 items-start gap-3">
				<div className="skeleton-line mt-0.5 size-8 shrink-0 rounded-md" />
				<div className="min-w-0 flex-1">
					<SkeletonLine blockHeight="1lh" minWidth={30} maxWidth={30} />
					<div className="text-sm">
						<SkeletonLine blockHeight="1lh" minWidth={24} maxWidth={24} />
					</div>
					<div className="mt-1 text-xs">
						<SkeletonLine blockHeight="1lh" minWidth={18} maxWidth={18} />
					</div>
				</div>
			</div>
			<div className="h-6.5" />
		</div>
	);
}

export default SecuritySettings;
