// Parser for as.predefined — simplified AngelScript declarations
// Populates the type database without UE editor TCP connection

import * as fs from 'fs';
import * as typedb from './database';

// ─── Parsing helpers ──────────────────────────────────────────

function trimLine(line: string): string {
	return line.trim();
}

function isBlank(line: string): boolean {
	return line.trim().length === 0;
}

function isComment(line: string): boolean {
	const t = line.trim();
	return t.startsWith('//') || t.startsWith('#');
}

// Split args string like "float X, float Y, float Z" into typed arg tuples
function parseArgs(argsStr: string): Array<[string, string | null]> {
	const result: Array<[string, string | null]> = [];
	if (!argsStr || argsStr.trim().length === 0)
		return result;

	// We need to handle commas that are NOT inside angle brackets
	let depth = 0;
	let current = '';
	for (let i = 0; i < argsStr.length; i++) {
		const ch = argsStr[i];
		if (ch === '<') depth++;
		else if (ch === '>') depth--;
		else if (ch === ',' && depth === 0) {
			result.push(parseSingleArg(current.trim()));
			current = '';
			continue;
		}
		current += ch;
	}
	if (current.trim().length > 0)
		result.push(parseSingleArg(current.trim()));

	return result;
}

function parseSingleArg(arg: string): [string, string | null] {
	// Split on last space for name vs typename
	// But handle cases like "const FVector&in other" where the name is "other"
	// The typename is everything before the last word (which is the name)
	const trimmed = arg.trim();
	const spaceIdx = trimmed.lastIndexOf(' ');
	if (spaceIdx === -1)
		return [trimmed, null];

	const possibleName = trimmed.substring(spaceIdx + 1).trim();
	const typePart = trimmed.substring(0, spaceIdx).trim();

	// If the last word looks like a type keyword (const, &, in, out), it's not a name
	if (possibleName === 'const' || possibleName === '&' || possibleName === 'in'
		|| possibleName === 'out' || possibleName === 'inout'
		|| possibleName.endsWith('&'))
		return [trimmed, null];

	return [typePart, possibleName];
}

function parseMethodArgs(argsStr: string): typedb.DBArg[] {
	const parsed = parseArgs(argsStr);
	return parsed.map(([type, name]) => {
		const arg = new typedb.DBArg();
		arg.typename = type;
		arg.name = name;
		return arg;
	});
}

// Extract the content inside { ... } braces starting at lineIndex
function extractBracedBlock(lines: string[], lineIndex: number): { content: string[]; endLine: number } | null {
	const content: string[] = [];
	let braceDepth = 0;
	let foundOpen = false;
	let i = lineIndex;

	for (; i < lines.length; i++) {
		const line = lines[i];
		for (const ch of line) {
			if (ch === '{') { braceDepth++; foundOpen = true; }
			else if (ch === '}') { braceDepth--; }
		}
		if (foundOpen) {
			if (braceDepth <= 0)
				break;
			// Don't add the closing brace line itself if we just closed
		}
		if (foundOpen)
			content.push(line);
	}

	if (!foundOpen)
		return null;

	return { content, endLine: i };
}

// ─── Main parsing ─────────────────────────────────────────────

export function LoadPredefinedTypes(predefinedFilePath: string): void {
	const content = fs.readFileSync(predefinedFilePath, 'utf-8');
	const lines = content.split('\n');

	// Note: AddPrimitiveTypes and FinishTypesFromUnreal are called centrally
	// by the hybrid init logic in server.ts — NOT here.

	let i = 0;
	while (i < lines.length) {
		const trimmed = trimLine(lines[i]);

		if (isBlank(trimmed) || isComment(trimmed)) {
			i++;
			continue;
		}

		// Class declaration: class Name [: SuperType] [template] {
		if (trimmed.startsWith('class ')) {
			const classInfo = parseClass(lines, i);
			if (classInfo) {
				registerClass(classInfo);
				i = classInfo.endLine + 1;
			} else {
				i++;
			}
			continue;
		}

		// Namespace declaration: namespace Name {
		if (trimmed.startsWith('namespace ')) {
			const nsInfo = parseNamespace(lines, i);
			if (nsInfo) {
				registerNamespace(nsInfo);
				i = nsInfo.endLine + 1;
			} else {
				i++;
			}
			continue;
		}

		// Auto-generated function: ReturnType QualName::FunctionName(args);
		if (trimmed.includes('::') && trimmed.includes('(') && trimmed.endsWith(';')) {
			registerAutoGenFunction(trimmed);
			i++;
			continue;
		}

		// Global function declaration: ReturnType FunctionName(args);
		const parenIdx = trimmed.indexOf('(');
		if (parenIdx > 0 && trimmed.endsWith(';')) {
			registerGlobalFunction(trimmed);
			i++;
			continue;
		}

		// Skip unknown lines (like just 'bool' / primitive type lists etc)
		i++;
	}

	// FinishTypesFromUnreal is called centrally by server.ts hybrid init logic
}

// ─── Class parsing ────────────────────────────────────────────

interface ClassInfo {
	name: string;
	templateParams: string[];
	superType: string | null;
	bodyLines: string[];
	endLine: number;
}

function parseClass(lines: string[], startLine: number): ClassInfo | null {
	let line = lines[startLine];
	const trimmed = trimLine(line);

	// Parse "class Name" or "class Name<T>" or "class Name : SuperType"
	let rest = trimmed.substring(6).trim(); // after "class "

	// Template parameters
	const templateParams: string[] = [];
	if (rest.includes('<')) {
		const tStart = rest.indexOf('<');
		const tEnd = rest.indexOf('>');
		if (tStart >= 0 && tEnd > tStart) {
			const params = rest.substring(tStart + 1, tEnd).split(',');
			for (const p of params)
				templateParams.push(p.trim());
			rest = rest.substring(0, tStart) + rest.substring(tEnd + 1);
		}
	}

	// Super type
	let superType: string | null = null;
	const colonIdx = rest.indexOf(':');
	if (colonIdx >= 0) {
		superType = rest.substring(colonIdx + 1).trim();
		rest = rest.substring(0, colonIdx).trim();
	}

	const className = rest.replace('{', '').trim();
	if (className.length === 0)
		return null;

	// Find the opening brace
	let braceLine = startLine;
	while (braceLine < lines.length && !lines[braceLine].includes('{'))
		braceLine++;

	const block = extractBracedBlock(lines, braceLine);
	if (!block)
		return null;

	return {
		name: className,
		templateParams,
		superType,
		bodyLines: block.content,
		endLine: block.endLine,
	};
}

function registerClass(info: ClassInfo): void {
	const dbtype = new typedb.DBType();
	dbtype.name = info.name;
	dbtype.supertype = info.superType;
	dbtype.declaredModule = null; // Acts like a UE type
	dbtype.isPrimitive = false;
	dbtype.isStruct = false;
	dbtype.isEnum = false;
	dbtype.isTemplateInstantiation = info.templateParams.length > 0;
	if (info.templateParams.length > 0) {
		dbtype.templateSubTypes = info.templateParams;
		dbtype.templateBaseType = info.name;
	}

	// Parse body content (inside braces)
	for (const bodyLine of info.bodyLines) {
		const t = trimLine(bodyLine);
		if (isBlank(t) || isComment(t) || t === '{' || t === '}')
			continue;

		// Destructor: ~ClassName();
		if (t.startsWith('~')) {
			const method = parseMethodDecl(t);
			if (method) {
				method.returnType = 'void';
				dbtype.addSymbol(method);
			}
			continue;
		}

		// Check if this is a property or method
		// Methods have parentheses: ReturnType Name(args)
		if (t.includes('(')) {
			// Could be constructor (same name as class), method, or property with default
			const method = parseMethodDecl(t);
			if (method) {
				dbtype.addSymbol(method);
			}
			continue;
		}

		// Otherwise it's one or more properties: Type name1 [, name2, name3];
		if (t.endsWith(';')) {
			parseAndAddProperties(dbtype, t);
		}
	}

	typedb.AddUnrealTypeToDatabase(null, dbtype);
}

// ─── Property parsing ─────────────────────────────────────────

function parseAndAddProperties(dbtype: typedb.DBType, line: string): void {
	// Format: "float X, Y, Z;" or "uint8 R, G, B, A;"
	const withoutSemi = line.endsWith(';') ? line.substring(0, line.length - 1) : line;
	const trimmed = withoutSemi.trim();

	// Split on first space to get typename
	const spaceIdx = trimmed.indexOf(' ');
	if (spaceIdx === -1)
		return;

	const typename = trimmed.substring(0, spaceIdx).trim();
	const namesPart = trimmed.substring(spaceIdx + 1).trim();
	const names = namesPart.split(',').map(n => n.trim()).filter(n => n.length > 0);

	for (const name of names) {
		const prop = new typedb.DBProperty();
		prop.name = name;
		prop.typename = typename;
		prop.declaredModule = null;
		dbtype.addSymbol(prop);
	}
}

// ─── Method parsing ───────────────────────────────────────────

function parseMethodDecl(line: string): typedb.DBMethod | null {
	// Format: "ReturnType Name(args)" or "ReturnType Name(args) const" or "void FVector()"
	let t = line;
	// Remove trailing semicolon
	if (t.endsWith(';'))
		t = t.substring(0, t.length - 1);

	t = t.trim();

	// Check for const at the end
	const isConst = t.endsWith(' const');
	if (isConst)
		t = t.substring(0, t.length - 6).trim();

	// Find the opening paren to split return type + name from args
	const parenIdx = t.indexOf('(');
	if (parenIdx === -1)
		return null;

	const beforeParen = t.substring(0, parenIdx).trim();
	const argsStr = t.substring(parenIdx + 1, t.lastIndexOf(')'));

	// Split before-paren into return type and name
	// The name is the last word, everything before is return type
	const spaceIdx = beforeParen.lastIndexOf(' ');
	let returnType: string;
	let methodName: string;

	if (spaceIdx === -1) {
		// Just a name, no return type (maybe constructor)
		returnType = 'void';
		methodName = beforeParen;
	} else {
		returnType = beforeParen.substring(0, spaceIdx).trim();
		methodName = beforeParen.substring(spaceIdx + 1).trim();
	}

	if (returnType.length === 0)
		returnType = 'void';

	const method = new typedb.DBMethod();
	method.name = methodName;
	method.returnType = returnType;
	method.args = parseMethodArgs(argsStr);
	method.isConst = isConst;
	method.isConstructor = (methodName === beforeParen) || (!beforeParen.includes(' ')); // heuristic
	method.isBlueprintEvent = false;
	method.declaredModule = null;

	return method;
}

// ─── Namespace parsing ────────────────────────────────────────

interface NamespaceInfo {
	name: string;
	bodyLines: string[];
	endLine: number;
}

function parseNamespace(lines: string[], startLine: number): NamespaceInfo | null {
	const line = trimLine(lines[startLine]);
	const name = line.substring(10).replace('{', '').trim();
	if (name.length === 0)
		return null;

	// Find opening brace
	let braceLine = startLine;
	while (braceLine < lines.length && !lines[braceLine].includes('{'))
		braceLine++;

	const block = extractBracedBlock(lines, braceLine);
	if (!block)
		return null;

	return {
		name,
		bodyLines: block.content,
		endLine: block.endLine,
	};
}

function registerNamespace(info: NamespaceInfo): void {
	// Find or create the namespace
	let ns = typedb.LookupNamespace(null, info.name);
	if (!ns) {
		ns = new typedb.DBNamespace();
		ns.name = info.name;
		typedb.GetRootNamespace().addChildNamespace(ns);
	}

	// Parse functions in the namespace
	for (const bodyLine of info.bodyLines) {
		const t = trimLine(bodyLine);
		if (isBlank(t) || isComment(t) || t === '{' || t === '}')
			continue;

		if (t.includes('(') && t.endsWith(';')) {
			const method = parseMethodDecl(t);
			if (method) {
				method.declaredModule = null;
				ns.addSymbol(method);
			}
		}
	}
}

// ─── Auto-generated function parsing ──────────────────────────
// Format: "ReturnType QualName::FunctionName(args);"
// Where QualName can be a class name or namespace

function registerAutoGenFunction(line: string): void {
	let t = line.trim();
	if (t.endsWith(';'))
		t = t.substring(0, t.length - 1);
	t = t.trim();

	// Find the first "::" to split return type from qualified path
	const doubleColonIdx = t.indexOf('::');
	if (doubleColonIdx === -1)
		return;

	const beforeDoubleColon = t.substring(0, doubleColonIdx).trim();

	// The return type is everything before the last space before "::"
	// But this is tricky because the return type could contain spaces like "const TArray<FVector>&inout"
	// Strategy: split the return type from the qualname by finding the last space BEFORE the ::

	// Actually the format is: RETURN_TYPE QUALNAME::FUNCNAME(args)
	// We need to find where RETURN_TYPE ends. QualName always starts with a type-like name (A, U, F etc)
	// or lowercase namespace name.

	// Simpler: Find the last space before "::", that separates return type from qualname
	const lastSpaceBeforeColon = t.lastIndexOf(' ', doubleColonIdx);
	let returnType: string;
	let qualName: string;

	if (lastSpaceBeforeColon === -1) {
		// No return type? Use void
		returnType = 'void';
		qualName = beforeDoubleColon;
	} else {
		returnType = t.substring(0, lastSpaceBeforeColon).trim();
		qualName = t.substring(lastSpaceBeforeColon + 1, doubleColonIdx).trim();
	}

	if (returnType.length === 0)
		returnType = 'void';

	// Now parse the rest: FunctionName(args)
	const afterColon = t.substring(doubleColonIdx + 2).trim();
	const parenIdx = afterColon.indexOf('(');
	if (parenIdx === -1)
		return;

	const funcName = afterColon.substring(0, parenIdx).trim();
	const argsStr = afterColon.substring(parenIdx + 1, afterColon.lastIndexOf(')'));

	const method = new typedb.DBMethod();
	method.name = funcName;
	method.returnType = returnType;
	method.args = parseMethodArgs(argsStr);
	method.isConst = false;
	method.isBlueprintEvent = false;
	method.declaredModule = null;

	// Try to add to existing type first
	let targetType = typedb.GetTypeByName(qualName);
	if (targetType) {
		targetType.addSymbol(method);
		return;
	}

	// Try as namespace
	let targetNs = typedb.LookupNamespace(null, qualName);
	if (!targetNs) {
		// Create namespace for it
		targetNs = new typedb.DBNamespace();
		targetNs.name = qualName;
		typedb.GetRootNamespace().addChildNamespace(targetNs);
	}
	targetNs.addSymbol(method);
}

// ─── Global function parsing ──────────────────────────────────

function registerGlobalFunction(line: string): void {
	let t = line.trim();
	if (t.endsWith(';'))
		t = t.substring(0, t.length - 1);
	t = t.trim();

	const parenIdx = t.indexOf('(');
	if (parenIdx === -1)
		return;

	const beforeParen = t.substring(0, parenIdx).trim();
	const argsStr = t.substring(parenIdx + 1, t.lastIndexOf(')'));

	// Split return type and name
	const spaceIdx = beforeParen.lastIndexOf(' ');
	let returnType: string;
	let funcName: string;

	if (spaceIdx === -1) {
		returnType = 'void';
		funcName = beforeParen;
	} else {
		returnType = beforeParen.substring(0, spaceIdx).trim();
		funcName = beforeParen.substring(spaceIdx + 1).trim();
	}

	if (returnType.length === 0)
		returnType = 'void';

	// Check if "Print" etc — add to root namespace
	const method = new typedb.DBMethod();
	method.name = funcName;
	method.returnType = returnType;
	method.args = parseMethodArgs(argsStr);
	method.isConst = false;
	method.isBlueprintEvent = false;
	method.declaredModule = null;

	typedb.GetRootNamespace().addSymbol(method);
}
