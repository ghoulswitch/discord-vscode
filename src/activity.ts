import { basename, parse, sep } from 'path';
import { debug, env, extensions, Selection, TextDocument, window, workspace } from 'vscode';

import {
	CONFIG_KEYS,
	DEBUG_IMAGE_KEY,
	EMPTY,
	FAKE_EMPTY,
	FILE_SIZES,
	IDLE_IMAGE_KEY,
	REPLACE_KEYS,
	UNKNOWN_GIT_BRANCH,
	UNKNOWN_GIT_REPO_NAME,
	VSCODE_IMAGE_KEY,
	VSCODE_INSIDERS_IMAGE_KEY,
} from './constants';
import { API, GitExtension } from './git';
import { log, LogLevel } from './logger';
import { getConfig, resolveFileIcon, toLower, toTitle, toUpper } from './util';

interface ActivityPayload {
	details?: string;
	state?: string;
	startTimestamp?: number | null;
	largeImageKey?: string;
	largeImageText?: string;
	smallImageKey?: string;
	smallImageText?: string;
	partyId?: string;
	partySize?: number;
	partyMax?: number;
	matchSecret?: string;
	joinSecret?: string;
	spectateSecret?: string;
	buttons?: { label: string; url: string }[];
	instance?: boolean;
}

export async function activity(previous: ActivityPayload = {}) {
	const config = getConfig();
	const swapBigAndSmallImage = config[CONFIG_KEYS.SwapBigAndSmallImage];

	const appName = env.appName;
	const defaultSmallImageKey = debug.activeDebugSession
		? DEBUG_IMAGE_KEY
		: appName.includes('Insiders')
		? VSCODE_INSIDERS_IMAGE_KEY
		: VSCODE_IMAGE_KEY;
	const defaultSmallImageText = config[CONFIG_KEYS.SmallImage].replace(REPLACE_KEYS.AppName, appName);
	const defaultLargeImageText = config[CONFIG_KEYS.LargeImageIdling];
	const removeDetails = config[CONFIG_KEYS.RemoveDetails];
	const removeLowerDetails = config[CONFIG_KEYS.RemoveLowerDetails];

	let state: ActivityPayload = {
		details: removeDetails
			? undefined
			: await details(CONFIG_KEYS.DetailsIdling, CONFIG_KEYS.DetailsEditing, CONFIG_KEYS.DetailsDebugging),
		startTimestamp: previous.startTimestamp ?? Date.now(),
		largeImageKey: IDLE_IMAGE_KEY,
		largeImageText: defaultLargeImageText,
		smallImageKey: defaultSmallImageKey,
		smallImageText: defaultSmallImageText,
	};

	if (swapBigAndSmallImage) {
		state = {
			...state,
			largeImageKey: defaultSmallImageKey,
			largeImageText: defaultSmallImageText,
			smallImageKey: IDLE_IMAGE_KEY,
			smallImageText: defaultLargeImageText,
		};
	}

	if (window.activeTextEditor) {
		const largeImageKey = resolveFileIcon(window.activeTextEditor.document);
		const largeImageText = config[CONFIG_KEYS.LargeImage]
			.replace(REPLACE_KEYS.LanguageLowerCase, toLower(largeImageKey))
			.replace(REPLACE_KEYS.LanguageTitleCase, toTitle(largeImageKey))
			.replace(REPLACE_KEYS.LanguageUpperCase, toUpper(largeImageKey))
			.padEnd(2, FAKE_EMPTY);

		state = {
			...state,
			details: removeDetails
				? undefined
				: await details(CONFIG_KEYS.DetailsIdling, CONFIG_KEYS.DetailsEditing, CONFIG_KEYS.DetailsDebugging),
			state: removeLowerDetails
				? undefined
				: await details(
						CONFIG_KEYS.LowerDetailsIdling,
						CONFIG_KEYS.LowerDetailsEditing,
						CONFIG_KEYS.LowerDetailsDebugging,
				  ),
		};

		if (swapBigAndSmallImage) {
			state = {
				...state,
				smallImageKey: largeImageKey,
				smallImageText: largeImageText,
			};
		} else {
			state = {
				...state,
				largeImageKey,
				largeImageText,
			};
		}

		log(LogLevel.Trace, `VSCode language id: ${window.activeTextEditor.document.languageId}`);
	}

	log(LogLevel.Debug, `Discord Presence being sent to discord:\n${JSON.stringify(state, null, 2)}`);

	return state;
}

async function details(idling: CONFIG_KEYS, editing: CONFIG_KEYS, debugging: CONFIG_KEYS) {
	const config = getConfig();
	let raw = (config[idling] as string).replace(REPLACE_KEYS.Empty, FAKE_EMPTY);

	if (window.activeTextEditor) {
		const fileName = basename(window.activeTextEditor.document.fileName);
		const { dir } = parse(window.activeTextEditor.document.fileName);
		const split = dir.split(sep);
		const dirName = split[split.length - 1];

		const noWorkspaceFound = config[CONFIG_KEYS.LowerDetailsNoWorkspaceFound].replace(REPLACE_KEYS.Empty, FAKE_EMPTY);
		const workspaceFolder = workspace.getWorkspaceFolder(window.activeTextEditor.document.uri);
		const workspaceFolderName = workspaceFolder?.name ?? noWorkspaceFound;
		const workspaceName = workspace.name?.replace(REPLACE_KEYS.VSCodeWorkspace, EMPTY) ?? workspaceFolderName;
		const workspaceAndFolder = `${workspaceName}${
			workspaceFolderName === FAKE_EMPTY ? '' : ` - ${workspaceFolderName}`
		}`;

		const fileIcon = resolveFileIcon(window.activeTextEditor.document);

		if (debug.activeDebugSession) {
			raw = config[debugging] as string;
		} else {
			raw = config[editing] as string;
		}

		if (workspaceFolder) {
			const { name } = workspaceFolder;
			const relativePath = workspace.asRelativePath(window.activeTextEditor.document.fileName).split(sep);
			relativePath.splice(-1, 1);
			raw = raw.replace(REPLACE_KEYS.FullDirName, `${name}${sep}${relativePath.join(sep)}`);
		}

		try {
			raw = await fileDetails(raw, window.activeTextEditor.document, window.activeTextEditor.selection);
		} catch (error) {
			log(LogLevel.Error, `Failed to generate file details: ${error as string}`);
		}
		raw = raw
			.replace(REPLACE_KEYS.FileName, fileName)
			.replace(REPLACE_KEYS.DirName, dirName)
			.replace(REPLACE_KEYS.Workspace, workspaceName)
			.replace(REPLACE_KEYS.WorkspaceFolder, workspaceFolderName)
			.replace(REPLACE_KEYS.WorkspaceAndFolder, workspaceAndFolder)
			.replace(REPLACE_KEYS.LanguageLowerCase, toLower(fileIcon))
			.replace(REPLACE_KEYS.LanguageTitleCase, toTitle(fileIcon))
			.replace(REPLACE_KEYS.LanguageUpperCase, toUpper(fileIcon));
	}

	return raw;
}

async function fileDetails(_raw: string, document: TextDocument, selection: Selection) {
	let raw = _raw.slice();

	if (raw.includes(REPLACE_KEYS.TotalLines)) {
		raw = raw.replace(REPLACE_KEYS.TotalLines, document.lineCount.toLocaleString());
	}

	if (raw.includes(REPLACE_KEYS.CurrentLine)) {
		raw = raw.replace(REPLACE_KEYS.CurrentLine, (selection.active.line + 1).toLocaleString());
	}

	if (raw.includes(REPLACE_KEYS.CurrentColumn)) {
		raw = raw.replace(REPLACE_KEYS.CurrentColumn, (selection.active.character + 1).toLocaleString());
	}

	if (raw.includes(REPLACE_KEYS.FileSize)) {
		let currentDivision = 0;
		let size: number;
		try {
			({ size } = await workspace.fs.stat(document.uri));
		} catch {
			size = document.getText().length;
		}
		const originalSize = size;
		if (originalSize > 1000) {
			size /= 1000;
			currentDivision++;
			while (size > 1000) {
				currentDivision++;
				size /= 1000;
			}
		}

		raw = raw.replace(
			REPLACE_KEYS.FileSize,
			`${originalSize > 1000 ? size.toFixed(2) : size}${FILE_SIZES[currentDivision]}`,
		);
	}

	let git: API | undefined;
	try {
		log(LogLevel.Debug, 'Loading git extension');
		const gitExtension = extensions.getExtension<GitExtension>('vscode.git');
		if (!gitExtension?.isActive) {
			log(LogLevel.Trace, 'Git extension not activated, activating...');
			await gitExtension?.activate();
		}
		git = gitExtension?.exports.getAPI(1);
	} catch (error) {
		log(LogLevel.Error, `Failed to load git extension, is git installed?; ${error as string}`);
	}

	if (raw.includes(REPLACE_KEYS.GitBranch)) {
		if (git?.repositories.length) {
			raw = raw.replace(
				REPLACE_KEYS.GitBranch,
				git.repositories.find((repo) => repo.ui.selected)?.state.HEAD?.name ?? FAKE_EMPTY,
			);
		} else {
			raw = raw.replace(REPLACE_KEYS.GitBranch, UNKNOWN_GIT_BRANCH);
		}
	}

	if (raw.includes(REPLACE_KEYS.GitRepoName)) {
		if (git?.repositories.length) {
			raw = raw.replace(
				REPLACE_KEYS.GitRepoName,
				git.repositories
					.find((repo) => repo.ui.selected)
					?.state.remotes[0].fetchUrl?.split('/')[1]
					.replace('.git', '') ?? FAKE_EMPTY,
			);
		} else {
			raw = raw.replace(REPLACE_KEYS.GitRepoName, UNKNOWN_GIT_REPO_NAME);
		}
	}

	return raw;
}
